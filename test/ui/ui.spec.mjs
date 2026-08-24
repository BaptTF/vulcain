import { chromium } from 'playwright'

const BASE = process.env.BASE_URL || 'http://127.0.0.1:7399'
const results = []
const check = (name, cond) => {
  results.push(cond)
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`)
}

const browser = await chromium.launch()
const page = await browser.newPage()
const consoleErrors = []
const pageErrors = []
page.on('console', m => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', e => pageErrors.push(String(e?.message ?? e)))

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)

const reactErrors = consoleErrors.filter(e => e.includes('Minified React error'))
check('no minified React error (ex #130)', reactErrors.length === 0)
if (reactErrors.length) console.log('  ->', reactErrors[0].slice(0, 200))
check('no uncaught page error', pageErrors.length === 0)
if (pageErrors.length) console.log('  ->', pageErrors[0])

check('app rendered (topbar)', await page.locator('.topbar .logo').isVisible())
check('chat panel rendered', await page.locator('.panel-chat .chat-header').isVisible())

const row = page.locator('[role="treeitem"]', { hasText: 'welcome.md' })
check('file tree lists welcome.md', await row.first().isVisible())

await row.first().click()
await page.waitForTimeout(800)
check('editor opens on click', await page.locator('.cm-editor').first().isVisible())
check(
  'editor shows file content',
  (await page.locator('.cm-content').first().textContent())?.includes('Bienvenue dans Vulcain') === true
)

let chatStatus = ''
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(1000)
  chatStatus = (await page.locator('.chat-status').textContent())?.trim() ?? ''
  if (chatStatus !== 'connexion…') break
}
console.log(`  chat status: ${chatStatus}`)
check('agent websocket connected (chat pret)', chatStatus === 'prêt')
check('real agent greeted via ACP bridge', (await page.locator('.chat-messages').textContent())?.includes('pi') === true)

// Le bouton Envoyer doit au minimum afficher le message de l'utilisateur
// (le bug historique etait un clic sans aucun effet quand la connexion pendait)
const userBubbleBefore = await page.locator('.msg.user').count()
await page.locator('.chat-input').fill('ping')
await page.locator('.chat-input').press('Enter')
let sent = false
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(500)
  const bubbles = await page.locator('.msg.user').count()
  const last = (await page.locator('.chat-messages').textContent()) ?? ''
  if (bubbles > userBubbleBefore && last.includes('ping')) {
    sent = true
    break
  }
}
check('bouton Envoyer fonctionne (message utilisateur affiché)', sent)

const wsFailures = consoleErrors.filter(e => e.includes('/api/acp') || e.includes('/api/watch'))
check('no websocket connection errors', wsFailures.length === 0)
if (wsFailures.length) console.log('  ->', wsFailures[0].slice(0, 160))

await page.screenshot({ path: '/work/ui-result.png', fullPage: true })

await browser.close()
const failed = results.filter(r => !r).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
