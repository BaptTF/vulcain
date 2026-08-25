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

// --- autosave: typing should persist to disk after the debounce ---
await page.locator('.cm-content').first().click()
await page.keyboard.type(' AUTOSAVE_MARKER')
await page.waitForTimeout(1600) // > AUTOSAVE_DELAY (1s) + latency
const diskContent = await page.evaluate(async () => {
  const r = await fetch(`/api/fs/file?ws=${encodeURIComponent(localStorage.getItem('vulcain.ws') || '')}&path=welcome.md`)
  return r.ok ? await r.text() : ''
})
check('autosave writes content to disk after typing', diskContent.includes('AUTOSAVE_MARKER'))
check('autosave clears dirty flag', !(await page.locator('.tab .dirty-dot').count()))

// --- external file change: open tab should refresh when a file is modified on disk ---
// use a dedicated file so welcome.md stays intact for the reload-restoration test below
const putFile = (path, content) =>
  page.evaluate(async ({ path: p, content: c }) => {
    const ws = localStorage.getItem('vulcain.ws') || ''
    const r = await fetch('/api/fs/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ws, path: p, content: c })
    })
    if (!r.ok) throw new Error('PUT failed: ' + r.status)
  }, { path, content })
const editorText = () => page.locator('.cm-content').first().textContent()
const waitForEditor = async marker => {
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(300)
    if (((await editorText()) ?? '').includes(marker)) return true
  }
  return false
}

// active tab refresh
await putFile('ext-change.md', 'ext-init\n')
await page.waitForTimeout(600)
const extRow = page.locator('[role="treeitem"]', { hasText: 'ext-change.md' }).first()
check('file tree lists externally created file', await extRow.isVisible())
await extRow.click()
await page.waitForTimeout(500)
const actMarker = 'ACTIVE_CHANGE_MARKER'
await putFile('ext-change.md', `ext-updated ${actMarker}\n`)
check('active tab refreshes content when file changes on disk', await waitForEditor(actMarker))

// background tab refresh (content must be pulled in even while not focused)
const bkgMarker = 'BKG_CHANGE_MARKER'
await putFile('bkg-change.md', `bkg-init ${bkgMarker}\n`)
await page.waitForTimeout(600)
const bkgRow = page.locator('[role="treeitem"]', { hasText: 'bkg-change.md' }).first()
check('file tree lists second external file', await bkgRow.isVisible())
await bkgRow.click()
await page.waitForTimeout(500)
await page.locator('[role="treeitem"]', { hasText: 'ext-change.md' }).first().click()
await page.waitForTimeout(300)
await putFile('bkg-change.md', `bkg-updated ${bkgMarker}\n`)
await page.waitForTimeout(800)
await bkgRow.click()
await page.waitForTimeout(300)
check('background tab refreshes content when file changes on disk', ((await editorText()) ?? '').includes(bkgMarker))

// bring welcome.md back to the foreground so the reload-restoration check targets it
await page.locator('[role="treeitem"]', { hasText: 'welcome.md' }).first().click()
await page.waitForTimeout(300)

// --- remember open file across reload ---
const persisted = await page.evaluate(() => {
  const key = `vulcain.tabs.${localStorage.getItem('vulcain.ws') || ''}`
  return localStorage.getItem(key)
})
check('open tabs persisted to localStorage', !!persisted && persisted.includes('welcome.md'))

await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
check('editor reopens after reload', await page.locator('.cm-editor').first().isVisible())
check(
  'reloaded tab is the restored file',
  ((await editorText()) ?? '').includes('Bienvenue dans Vulcain') === true
)

// --- pane toggles (viewbar) ---
const paneToggle = name => page.locator('.viewbar .pane-toggle', { hasText: name })
// collapsed panels are rendered at zero width (flex-basis:0), so test rendered width, not CSS visibility
const boxVisible = async sel => {
  const el = page.locator(sel).first()
  if (!(await el.count())) return false
  return await el.evaluate(n => n.getBoundingClientRect().width > 4)
}
check('viewbar shows 4 pane toggles', (await page.locator('.viewbar .pane-toggle').count()) === 4)
check(
  'all main panes visible by default',
  (await boxVisible('.panel-preview')) &&
    (await boxVisible('.panel-chat')) &&
    (await boxVisible('.cm-editor'))
)

// toggle agent off and back on
await paneToggle('Agent').click()
await page.waitForTimeout(300)
check('agent panel hidden when toggled off', !(await boxVisible('.panel-chat')))
check('agent toggle reflects hidden state', await paneToggle('Agent').evaluate(el => !el.classList.contains('active')))
await paneToggle('Agent').click()
await page.waitForTimeout(300)
check('agent panel reappears when toggled on', await boxVisible('.panel-chat'))

// guard: cannot collapse the last visible main pane (editor/preview/agent)
await paneToggle('Preview').click()
await page.waitForTimeout(300)
await paneToggle('Agent').click()
await page.waitForTimeout(300)
check('preview toggled off', await paneToggle('Preview').evaluate(el => !el.classList.contains('active')))
check('agent toggled off', await paneToggle('Agent').evaluate(el => !el.classList.contains('active')))
check('editor stays active with others off', await paneToggle('Editor').evaluate(el => el.classList.contains('active')))
await paneToggle('Editor').click()
await page.waitForTimeout(300)
check('guard blocks collapsing the last main pane', await paneToggle('Editor').evaluate(el => el.classList.contains('active')))
// restore all panes
await paneToggle('Preview').click()
await paneToggle('Agent').click()
await page.waitForTimeout(300)
check('panes restored', (await boxVisible('.panel-preview')) && (await boxVisible('.panel-chat')))

// --- layout persists across reload ---
await paneToggle('Agent').click()
await page.waitForTimeout(300)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
check('collapsed agent stays collapsed after reload', !(await boxVisible('.panel-chat')))
await paneToggle('Agent').click()
await page.waitForTimeout(300)
check('agent expandable after reload', await boxVisible('.panel-chat'))

// --- typst preview page fidelity (SVG rescaled to container width) ---
await putFile('page.typ', '#set page(width: 10cm, height: 15cm)\n#align(center)[Typst Page]\n')
await page.waitForTimeout(800)
const typRow = page.locator('[role="treeitem"]', { hasText: 'page.typ' }).first()
await typRow.click()
let typFound = false
for (let i = 0; i < 24; i++) {
  await page.waitForTimeout(500) // typst WASM compile + render
  if (await page.locator('.typ-body svg').count()) {
    typFound = true
    break
  }
}
const typSvg = page.locator('.typ-body svg').first()
if (typFound) {
  const cw = await page.locator('.typ-body').evaluate(el => el.clientWidth)
  const svgW = parseFloat((await typSvg.getAttribute('width')) ?? '0')
  const svgH = parseFloat((await typSvg.getAttribute('height')) ?? '0')
  check('typst svg rescaled to container width', svgW > 0 && Math.abs(svgW - cw) < 2)
  check('typst svg keeps positive aspect', svgH > 0)
} else {
  check('typst svg rescaled to container width', false)
  check('typst svg keeps aspect ratio', false)
}
// bring welcome.md back for the chat section below
await page.locator('[role="treeitem"]', { hasText: 'welcome.md' }).first().click()
await page.waitForTimeout(300)

let chatStatus = ''
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(1000)
  chatStatus = (await page.locator('.chat-status').textContent())?.trim() ?? ''
  if (chatStatus !== 'connexion…') break
}
console.log(`  chat status: ${chatStatus}`)
check('agent websocket connected (chat pret)', chatStatus === 'prêt')
check('real agent greeted via ACP bridge', (await page.locator('.chat-messages').textContent())?.includes('fake-agent') === true)

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
