import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import { loadConfig } from './config.js'
import { registerFsApi } from './fs-api.js'
import { registerWatchApi } from './watch.js'
import { registerAcpBridge } from './acp-bridge.js'
import { syncPiModels, syncSystemPrompt } from './pisync.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const webDist = path.resolve(here, '../../web/dist')

async function main(): Promise<void> {
  const cfg = loadConfig()
  const modelsFile = syncPiModels(cfg)
  if (modelsFile) console.log(`[vulcain] synced pi models -> ${modelsFile}`)
  const systemPromptFile = syncSystemPrompt(cfg)
  if (systemPromptFile) console.log(`[vulcain] synced system prompt -> ${systemPromptFile}`)

  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024 })

  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 * 1024 } })
  registerFsApi(app)
  registerWatchApi(app)
  registerAcpBridge(app)

  app.setErrorHandler((err, req, reply) => {
    const status = (err as any).statusCode ?? 500
    const message = err instanceof Error ? err.message : String(err)
    if (!reply.sent) {
      reply.code(typeof status === 'number' ? status : 500).send({ error: message })
    }
  })

  try {
    await app.register(fastifyStatic, { root: webDist })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) {
        reply.code(404).send({ error: 'not found' })
      } else {
        reply.sendFile('index.html')
      }
    })
  } catch {
    console.warn(`[vulcain] web/dist not found at ${webDist}, API only`)
  }

  const host = process.env.VULCAIN_HOST || cfg.server.host
  const port = Number(process.env.VULCAIN_PORT || cfg.server.port)
  await app.listen({ host, port })
  console.log(`[vulcain] listening on http://${host}:${port}`)
}

main().catch(err => {
  console.error('[vulcain] fatal:', err)
  process.exit(1)
})
