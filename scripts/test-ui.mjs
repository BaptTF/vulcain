#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const home = process.env.VULCAIN_HOME || '/tmp/vulcain-test'
const port = process.env.VULCAIN_PORT || '7399'
const baseUrl = process.env.BASE_URL || `http://127.0.0.1:${port}`
const configPath = path.join(home, 'config', 'config.json')
const fakeAgent = path.join(repoRoot, 'test', 'fake-agent.mjs')

const env = {
  ...process.env,
  VULCAIN_HOME: home,
  VULCAIN_WORKSPACES: path.join(home, 'workspaces'),
  VULCAIN_PORT: port,
  BASE_URL: baseUrl,
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || undefined
}

async function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', code => resolve(code))
  })
}

function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`${baseUrl}/api/meta`)
        if (res.ok) return resolve()
      } catch {}
      if (Date.now() > deadline) return reject(new Error(`server not ready on ${baseUrl}`))
      setTimeout(tick, 300)
    }
    tick()
  })
}

// fresh home so bootstrap writes the config with the fake agent
fs.rmSync(home, { recursive: true, force: true })
const bootstrapCode = await run('node', [path.join(repoRoot, 'scripts', 'bootstrap.mjs')])
if (bootstrapCode !== 0) process.exit(bootstrapCode ?? 1)

// force the agent command toward the fake agent (e2e / ui suite)
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
cfg.agent = { command: ['node', fakeAgent], args: [] }
fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n')

// build the UI test fixture in a fresh workspace each run
const notesWs = path.join(home, 'workspaces', 'notes')
fs.rmSync(notesWs, { recursive: true, force: true })
fs.mkdirSync(notesWs, { recursive: true })
fs.writeFileSync(
  path.join(notesWs, 'welcome.md'),
  `# Bienvenue dans Vulcain\n\n- Créez des notes en **markdown**, la preview est dans la barre d'onglets.\n- Créez un fichier \`.typ\` pour écrire du Typst et exporter des PDF propres.\n- Le chat à droite parle à votre agent pi (configuré via bifrost).\n`
)

const server = spawn('node', [path.join(repoRoot, 'server', 'dist', 'index.js')], { env, stdio: 'inherit' })
let exitCode = 1
try {
  await waitForServer(20000)
  exitCode = await run('node', [path.join(repoRoot, 'test', 'ui', 'ui.spec.mjs')])
} catch (e) {
  console.error('[test-ui]', e.message)
} finally {
  server.kill('SIGTERM')
}
process.exit(exitCode ?? 1)
