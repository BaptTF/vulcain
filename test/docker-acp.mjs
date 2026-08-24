import WebSocket from 'ws'

const PORT = process.env.PORT ?? 7331
const acp = new WebSocket(`ws://127.0.0.1:${PORT}/api/acp?ws=Notes`)
const pending = new Map()
let nextId = 1

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    acp.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`timeout ${method}`))
      }
    }, 30000)
  })
}

acp.on('message', line => {
  const msg = JSON.parse(line.toString())
  if (msg.id !== undefined && pending.has(msg.id)) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
  }
})

await new Promise((r, j) => {
  acp.once('open', r)
  acp.once('error', j)
})
console.log('PASS ws open')

const init = await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })
console.log('agent:', JSON.stringify(init.agentInfo ?? init))
if (!init.protocolVersion) throw new Error('no protocolVersion')
console.log('PASS initialize (vrai pi-acp)')

const authNote = init.authMethods?.length ? ` (authMethods: ${init.authMethods.map(a => a.id).join(',')})` : ' (aucune auth requise)'
console.log('auth:' + authNote)

const sess = await rpc('session/new', { cwd: '.', mcpServers: [] })
if (!sess.sessionId) throw new Error('no sessionId')
console.log('sessionId:', sess.sessionId.slice(0, 12) + '…')
console.log('PASS session/new')

acp.close()
await new Promise(r => setTimeout(r, 500))
console.log('\nACP BRIDGE DOCKER: OK')
process.exit(0)
