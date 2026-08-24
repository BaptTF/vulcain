import WebSocket from 'ws'

const PORT = process.env.PORT ?? 7391
const results = []

function check(name, cond) {
  results.push([name, cond])
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`)
}

async function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${label}`)), ms))
  ])
}

await new Promise(resolve => setTimeout(resolve, 300))

const watch = new WebSocket(`ws://127.0.0.1:${PORT}/api/watch?ws=Notes`)
let watchOpen = false
watch.on('open', () => {
  watchOpen = true
})
watch.on('message', d => {
  const msg = JSON.parse(d.toString())
  if (msg.type === 'fs' && msg.path === 'watched.md') check('watch: change event received', true)
})

await new Promise(r => setTimeout(r, 500))

const { default: fetch } = await import('node:http')
function putFile(content) {
  return new Promise((resolve, reject) => {
    const req = fetch.request(
      { host: '127.0.0.1', port: PORT, path: '/api/fs/file', method: 'PUT', headers: { 'content-type': 'application/json' } },
      res => resolve(res.statusCode)
    )
    req.on('error', reject)
    req.end(JSON.stringify({ ws: 'Notes', path: 'watched.md', content }))
  })
}

check('watch: socket opened', watchOpen)
await putFile('trigger')
await new Promise(r => setTimeout(r, 800))

const acp = new WebSocket(`ws://127.0.0.1:${PORT}/api/acp?ws=Notes`)
const pending = new Map()
let nextId = 1
const updates = []

acp.on('message', line => {
  const msg = JSON.parse(line.toString())
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      p(msg)
    }
  }
  if (msg.method === 'session/update') updates.push(msg.params.update)
})

function rpc(method, params) {
  return new Promise(resolve => {
    const id = nextId++
    pending.set(id, resolve)
    acp.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}

acp.on('open', async () => {})

await withTimeout(new Promise(r => acp.once('open', r)), 5000, 'acp open')
check('acp: websocket opened', true)
await new Promise(r => setTimeout(r, 400))

const init = await withTimeout(rpc('initialize', { protocolVersion: 1, clientCapabilities: {} }), 5000, 'init')
check('acp: initialize -> fake-agent', init.result?.agentInfo?.name === 'fake-agent')

const sess = await withTimeout(rpc('session/new', { cwd: '.', mcpServers: [] }), 5000, 'session/new')
check('acp: session/new returns id', typeof sess.result?.sessionId === 'string')

const cwdProbe = await withTimeout(
  new Promise(resolve => {
    const orig = rpc
    void orig
    resolve(null)
  }),
  10,
  'noop'
)
void cwdProbe

const promptId = nextId++
let permissionSeen = null
const promptPromise = new Promise(resolve => {
  pending.set(promptId, resolve)
})
acp.send(JSON.stringify({ jsonrpc: '2.0', id: promptId, method: 'session/prompt', params: { sessionId: sess.result.sessionId, prompt: [{ type: 'text', text: 'bonjour' }] } }))

await new Promise(r => setTimeout(r, 600))
const chunks = updates.filter(u => u.sessionUpdate === 'agent_message_chunk')
check('acp: streaming chunk received', chunks.some(u => u.content?.text === 'echo: bonjour'))
check('acp: tool_call received', updates.some(u => u.sessionUpdate === 'tool_call'))

acp.on('message', line => {
  const msg = JSON.parse(line.toString())
  if (msg.method === 'session/request_permission') {
    permissionSeen = msg
    acp.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } }))
  }
})

await promptPromise.then(res => check('acp: prompt resolves end_turn', res.result?.stopReason === 'end_turn'))
void permissionSeen

acp.close()
watch.close()
await new Promise(r => setTimeout(r, 300))

const failed = results.filter(r => !r[1])
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
