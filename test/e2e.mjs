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

const { default: http } = await import('node:http')
function reqJson(method, path, body) {
  return new Promise((resolve, reject) => {
    const headers = body !== undefined ? { 'content-type': 'application/json' } : {}
    const r = http.request(
      { host: '127.0.0.1', port: PORT, path, method, agent: false, headers },
      res => {
        let data = ''
        res.on('data', c => (data += c))
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }))
      }
    )
    r.on('error', reject)
    r.end(body !== undefined ? JSON.stringify(body) : undefined)
  })
}

async function chatStream(payload) {
  const body = JSON.stringify(payload)
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/api/chat',
        method: 'POST',
        agent: false,
        headers: { 'content-type': 'application/json' }
      },
      res => {
        let buf = ''
        const chunks = []
        res.on('data', c => {
          buf += c.toString()
          let idx
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim()
            buf = buf.slice(idx + 1)
            if (!line.startsWith('data: ')) continue
            const payload = line.slice(6).trim()
            if (payload === '[DONE]') continue
            try {
              chunks.push(JSON.parse(payload))
            } catch {}
          }
        })
        res.on('end', () => resolve({ status: res.statusCode, chunks }))
      }
    )
    r.on('error', reject)
    r.end(body)
  })
}

const clashDir = `__clash_dir_${Date.now()}`
await reqJson('POST', '/api/fs/mkdir', { ws: 'Notes', path: clashDir })
const touchClash = await reqJson('POST', '/api/fs/touch', { ws: 'Notes', path: clashDir })
check('fs: touch on existing dir gives clear error', touchClash.status === 500 && /dossier porte déjà ce nom/.test(touchClash.body.error ?? ''))

const clashFile = `__clash_file_${Date.now()}`
await reqJson('PUT', '/api/fs/file', { ws: 'Notes', path: clashFile, content: 'x' })
const mkdirClash = await reqJson('POST', '/api/fs/mkdir', { ws: 'Notes', path: clashFile })
check('fs: mkdir on existing file gives clear error', mkdirClash.status === 500 && /fichier porte déjà ce nom/.test(mkdirClash.body.error ?? ''))

const createdWs = `__created_${Date.now()}`
const createWs = await reqJson('POST', '/api/workspaces', { name: createdWs, create: true })
check('workspaces: create creates folder + registers', createWs.status === 200 && createWs.body?.ok)
const metaAfter = await reqJson('GET', '/api/meta')
check(
  'workspaces: created appears in meta',
  metaAfter.body?.workspaces?.some(w => w.name === createdWs)
)
const createdPut = await reqJson('PUT', '/api/fs/file', { ws: createdWs, path: 'probe.md', content: 'ok' })
const createdRead = await reqJson('GET', `/api/fs/file?ws=${createdWs}&path=probe.md`)
check(
  'workspaces: created workspace readable',
  createdPut.status === 200 && createdRead.body?.content === 'ok'
)
const removed = await reqJson('DELETE', `/api/workspaces/${createdWs}`)
const metaAfterDel = await reqJson('GET', '/api/meta')
check(
  'workspaces: removed on cleanup',
  removed.status === 200 && !metaAfterDel.body?.workspaces?.some(w => w.name === createdWs)
)

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

function putFile(content) {
  return new Promise((resolve, reject) => {
    const req = http.request(
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

// the server syncs the configured SYSTEM.md into pi's agent dir at boot
{
  const { default: fs } = await import('node:fs')
  const { default: os } = await import('node:os')
  const { default: path } = await import('node:path')
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent')
  check('chat: SYSTEM.md synced to pi agent dir', fs.existsSync(path.join(agentDir, 'SYSTEM.md')))
}

const stream = await withTimeout(
  chatStream({ workspace: 'Notes', messages: [{ role: 'user', content: 'bonjour' }] }),
  10000,
  'chat stream'
)
check('chat: POST /api/chat returns 200', stream.status === 200)
const textDelta = stream.chunks.filter(c => c.type === 'text-delta').map(c => c.delta).join('')
check('chat: text streamed (echo)', textDelta === 'echo: bonjour')
check(
  'chat: tool call part received',
  stream.chunks.some(c => c.type === 'tool-input-available' && c.toolName === 'read')
)
check(
  'chat: tool result part received',
  stream.chunks.some(c => c.type === 'tool-output-available' && c.output === 'file contents here')
)
check('chat: finish part received', stream.chunks.some(c => c.type === 'finish'))

const meta = stream.chunks.find(c => c.type === 'message-metadata')
check(
  'chat: message-metadata chunk has usage + contextUsage',
  meta?.messageMetadata?.custom?.usage?.totalTokens === 49 &&
    meta?.messageMetadata?.custom?.contextUsage?.contextWindow === 200000
)

const commands = await reqJson('GET', '/api/chat/commands?workspace=Notes')
check(
  'chat: commands endpoint lists slash commands',
  commands.status === 200 && Array.isArray(commands.body?.commands) && commands.body.commands.some(c => c.name === 'model')
)

// session isolation: distinct threadIds map to distinct durable pi sessions
const sessA = await chatStream({ workspace: 'Notes', sessionId: 'sess-a', messages: [{ role: 'user', content: 'hello a' }] })
const sessB = await chatStream({ workspace: 'Notes', sessionId: 'sess-b', messages: [{ role: 'user', content: 'hello b' }] })
check('chat: session A stream ok', sessA.status === 200 && sessA.chunks.some(c => c.type === 'finish'))
check('chat: session B stream ok', sessB.status === 200 && sessB.chunks.some(c => c.type === 'finish'))

const sessionsList = await reqJson('GET', '/api/chat/sessions?workspace=Notes')
const listed = (sessionsList.body?.sessions ?? []).map(s => s.id)
check('chat: sessions endpoint lists both thread ids', sessionsList.status === 200 && listed.includes('sess-a') && listed.includes('sess-b'))
check(
  'chat: sessions titles derive from first prompt',
  sessionsList.body?.sessions?.some(s => s.id === 'sess-a' && s.title === 'echo: hello a')
)

// reuse: a second message on the same thread increments its promptCount
await chatStream({ workspace: 'Notes', sessionId: 'sess-a', messages: [{ role: 'user', content: 'again' }] })
const sessionsList2 = await reqJson('GET', '/api/chat/sessions?workspace=Notes')
const sessAInfo = sessionsList2.body?.sessions?.find(s => s.id === 'sess-a')
check('chat: same sessionId reuses the session (promptCount increments)', sessAInfo?.messageCount === 2)

const commandsWithSession = await reqJson('GET', '/api/chat/commands?workspace=Notes&sessionId=sess-b')
check(
  'chat: commands endpoint works with sessionId param',
  commandsWithSession.status === 200 &&
    Array.isArray(commandsWithSession.body?.commands) &&
    commandsWithSession.body.commands.some(c => c.name === 'model')
)

const reset = await reqJson('POST', '/api/chat/reset', { workspace: 'Notes' })
check('chat: reset endpoint ok', reset.status === 200 && reset.body?.ok)

const badWs = await chatStream({ workspace: 'Nope', messages: [{ role: 'user', content: 'x' }] })
check('chat: unknown workspace rejected', badWs.status === 400)

const noText = await chatStream({ workspace: 'Notes', messages: [{ role: 'user', content: '' }] })
check('chat: empty user message rejected', noText.status === 400)

watch.close()
await new Promise(r => setTimeout(r, 300))

const failed = results.filter(r => !r[1])
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)