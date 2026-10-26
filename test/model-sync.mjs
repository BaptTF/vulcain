import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vulcain-model-sync-'))
const agentDir = path.join(HOME, 'pi-agent')
const notes = path.join(HOME, 'notes')
fs.mkdirSync(path.join(HOME, 'config'), { recursive: true })
fs.mkdirSync(notes, { recursive: true })
process.env.VULCAIN_HOME = HOME
process.env.PI_CODING_AGENT_DIR = agentDir

function writeCfg(modelId) {
  const cfg = {
    theme: 'dark',
    server: { host: '127.0.0.1', port: 7331 },
    workspaces: [{ name: 'Notes', path: notes }],
    configWorkspace: path.join(HOME, 'config'),
    llm: {
      provider: {
        name: 'bifrost',
        baseUrl: 'http://llm.test/v1',
        api: 'openai-completions',
        apiKey: '-',
        models: [{ id: modelId }]
      }
    },
    agent: {},
    tools: {}
  }
  fs.writeFileSync(path.join(HOME, 'config', 'config.json'), JSON.stringify(cfg, null, 2) + '\n')
}

writeCfg('opencode-go/old-model')

const { registerChat } = await import('../server/src/chat.ts')
const { syncPiModels } = await import('../server/src/pisync.ts')

const results = []
function check(name, cond) {
  results.push([name, cond])
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`)
}

let creates = 0
const backend = {
  async createSession() {
    creates += 1
    return {
      sessionId: `s${creates}`,
      isStreaming: false,
      async prompt() {},
      async abort() {},
      subscribe() {
        return () => {}
      },
      async commands() {
        return []
      },
      getUsage() {
        return {
          usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
          contextUsage: { tokens: null, contextWindow: 0, percent: null }
        }
      },
      dispose() {}
    }
  },
  refreshModels() {}
}

const app = Fastify({ logger: false })
registerChat(app, backend)
await app.listen({ host: '127.0.0.1', port: 0 })
const address = app.server.address()
const port = typeof address === 'object' && address ? address.port : 0

async function chat() {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workspace: 'Notes',
      messages: [{ role: 'user', content: 'ping' }]
    })
  })
  await res.text()
  return res.status
}

const provider = {
  name: 'bifrost',
  baseUrl: 'http://llm.test/v1',
  api: 'openai-completions',
  apiKey: '-',
  models: [{ id: 'opencode-go/old-model' }]
}
const firstSync = syncPiModels({ llm: { provider } })
const firstDoc = JSON.parse(fs.readFileSync(firstSync.file, 'utf8'))
check('syncPiModels: writes the configured model', firstSync.changed === true && firstDoc.providers.bifrost.models[0].id === 'opencode-go/old-model')
const secondSync = syncPiModels({ llm: { provider } })
check('syncPiModels: same provider leaves models.json unchanged', secondSync.changed === false)
provider.models = [{ id: 'opencode-go/replaced-model' }]
const thirdSync = syncPiModels({ llm: { provider } })
const thirdDoc = JSON.parse(fs.readFileSync(thirdSync.file, 'utf8'))
check('syncPiModels: model change rewrites models.json', thirdSync.changed === true && thirdDoc.providers.bifrost.models[0].id === 'opencode-go/replaced-model')
writeCfg('opencode-go/old-model')

try {
  const first = await chat()
  const second = await chat()
  check('chat: reuses the session while the model is unchanged', first === 200 && second === 200 && creates === 1)
  writeCfg('opencode-go/glm-5.3-flash')
  const third = await chat()
  const models = JSON.parse(fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8'))
  check('chat: config model change rewrites models.json and opens a new session', third === 200 && creates === 2 && models.providers.bifrost.models[0].id === 'opencode-go/glm-5.3-flash')
  const fourth = await chat()
  check('chat: keeps the new session on the following message', fourth === 200 && creates === 2)
} finally {
  await app.close()
  fs.rmSync(HOME, { recursive: true, force: true })
}

const failed = results.filter(r => !r[1])
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
