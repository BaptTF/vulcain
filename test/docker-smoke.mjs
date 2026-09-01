// Docker smoke test: server boots, serves the web app and the chat API routes.
const PORT = process.env.PORT ?? 7331
const base = `http://127.0.0.1:${PORT}`

async function req(path) {
  const res = await fetch(base + path)
  return { status: res.status, body: await res.text() }
}

const meta = await req('/api/meta')
if (meta.status !== 200 || !meta.body.includes('workspaces')) {
  throw new Error(`meta failed: ${meta.status} ${meta.body.slice(0, 200)}`)
}
console.log('PASS /api/meta')

const index = await req('/')
if (index.status !== 200 || !index.body.includes('<div id="root">')) {
  throw new Error(`index failed: ${index.status}`)
}
console.log('PASS static web served')

const commands = await req('/api/chat/commands?workspace=Notes')
// route reachable: 200 with a command list, or an agent-level error if pi has no credentials
if (commands.status >= 500) {
  throw new Error(`chat/commands unexpected: ${commands.status} ${commands.body.slice(0, 200)}`)
}
console.log(`PASS /api/chat/commands (${commands.status})`)

console.log('\nDOCKER SMOKE: OK')
process.exit(0)