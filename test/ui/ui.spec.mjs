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
let treeFetches = 0
page.on('request', r => {
  if (r.url().includes('/api/fs/tree')) treeFetches++
})
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

// --- context menu: right-click rename must close the menu (like VSCode) ---
await row.first().click({ button: 'right' })
await page.waitForTimeout(200)
const ctxMenu = page.locator('.tree-context')
check('context menu opens on right-click', await ctxMenu.isVisible())
await ctxMenu.locator('button', { hasText: 'Renommer' }).click()
await page.waitForTimeout(200)
check('context menu closes after clicking Renommer', (await ctxMenu.count()) === 0)
await page.keyboard.press('Escape') // cancel any active inline rename

// --- creation shows the file/folder icon on the left while naming (like VSCode) ---
const editRow = () => page.locator('[role="treeitem"]', { has: page.locator('.tree-edit-input') }).first()
const iconVisibleWhileNaming = async () =>
  (await editRow().count()) > 0 && (await editRow().locator('svg').count()) > 0

const newFileName = `new-${Date.now()}.md`
await page.locator('.tree-toolbar button[title="Nouveau fichier"]').click()
await page.waitForTimeout(300)
check('new file shows file icon while naming', await iconVisibleWhileNaming())
await editRow().locator('.tree-edit-input').fill(newFileName)
await editRow().locator('.tree-edit-input').press('Enter')
await page.waitForTimeout(400)
check('new file created with a name', await page.locator('[role="treeitem"]', { hasText: newFileName }).first().isVisible())

const newFolderName = `folder-${Date.now()}`
await page.locator('.tree-toolbar button[title="Nouveau dossier"]').click()
await page.waitForTimeout(300)
check('new folder shows folder icon while naming', await iconVisibleWhileNaming())
await editRow().locator('.tree-edit-input').fill(newFolderName)
await editRow().locator('.tree-edit-input').press('Enter')
await page.waitForTimeout(400)
check('new folder created with a name', await page.locator('[role="treeitem"]', { hasText: newFolderName }).first().isVisible())

// --- drag & drop: moving a file highlights the target folder (like VSCode) ---
const folderRow = page.locator('[role="treeitem"]', { hasText: newFolderName }).first()
const dndEvent = async ({ type, srcName, dstName }) =>
  page.evaluate(
    ({ type, srcName, dstName }) => {
      const rows = Array.from(document.querySelectorAll('[role="treeitem"]'))
      const srcRow = rows.find(r => r.textContent?.includes(srcName))
      const dstRow = rows.find(r => r.textContent?.includes(dstName))
      if (!srcRow || !dstRow) return false
      const src = srcRow.querySelector('[data-row="1"]') ?? srcRow
      const rect = dstRow.getBoundingClientRect()
      const target = type === 'dragstart' || type === 'dragend' ? src : dstRow
      target.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          dataTransfer: new DataTransfer()
        })
      )
      return true
    },
    { type, srcName, dstName }
  )
const dragStart = async name => {
  const ok = await dndEvent({ type: 'dragstart', srcName: name, dstName: name })
  if (ok) await page.waitForTimeout(60) // let react-dnd publish the drag source
  return ok
}
const dragHover = async (srcName, dstName) => {
  const ok = await dndEvent({ type: 'dragenter', srcName, dstName })
  return ok && (await dndEvent({ type: 'dragover', srcName, dstName }))
}
const dragDrop = async (srcName, dstName) => {
  const ok = await dndEvent({ type: 'drop', srcName, dstName })
  return ok && (await dndEvent({ type: 'dragend', srcName, dstName }))
}

check('drag source row found', await dragStart(newFileName))
check('target folder hovered', await dragHover(newFileName, newFolderName))
await page.waitForTimeout(250) // let react-arborist update willReceiveDrop + re-render
check(
  'target folder highlighted while dragging',
  await folderRow.locator('[data-row="1"]').evaluate(el => el.classList.contains('is-drop-target'))
)
check('drop dispatched', await dragDrop(newFileName, newFolderName))
await page.waitForTimeout(1000) // rename round-trip + watch debounce (250ms) + reload
const movedRow = page.locator('[role="treeitem"]', { hasText: newFileName }).first()
check('moved file still listed in tree', await movedRow.isVisible())
const fileLevel = Number(await movedRow.getAttribute('aria-level'))
const folderLevel = Number(await folderRow.getAttribute('aria-level'))
check('moved file nested one level under the folder', fileLevel === folderLevel + 1)

// --- optimistic move: the file must land in the folder before the rename API resolves ---
const moveFileName = `move-${Date.now()}.md`
await page.evaluate(async path => {
  const ws = localStorage.getItem('vulcain.ws') || ''
  const r = await fetch('/api/fs/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ws, path, content: 'move me\n' })
  })
  if (!r.ok) throw new Error('PUT failed: ' + r.status)
}, moveFileName)
await page.waitForTimeout(700) // watch debounce (250ms) + reload
check('optimistic move source file listed', await page.locator('[role="treeitem"]', { hasText: moveFileName }).first().isVisible())

// delay the rename endpoint: only an optimistic client-side move can nest the row this early
await page.route('**/api/fs/rename', async route => {
  await new Promise(r => setTimeout(r, 1000))
  await route.continue()
})
await dragStart(moveFileName)
await dragHover(moveFileName, newFolderName)
await dragDrop(moveFileName, newFolderName)
let nestedFast = false
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(50)
  const row = page.locator('[role="treeitem"]', { hasText: moveFileName }).first()
  if (!(await row.count())) continue
  const lvl = Number(await row.getAttribute('aria-level'))
  const dstLvl = Number(await folderRow.getAttribute('aria-level'))
  if (lvl === dstLvl + 1) {
    nestedFast = true
    break
  }
}
check('moved file appears nested before rename resolves (optimistic)', nestedFast)
await page.unroute('**/api/fs/rename')
await page.waitForTimeout(1500) // let the delayed rename land + watch reconcile
check('optimistic move reconciled on disk', await page.locator('[role="treeitem"]', { hasText: moveFileName }).first().isVisible())

// bring welcome.md back to the foreground so the autosave test below targets it
await row.first().click()
await page.waitForTimeout(300)

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
// a panel is "hidden" when its [data-panel] element is collapsed to zero width
const panelHidden = async id => {
  const el = page.locator(`[data-testid="${id}"]`).first()
  if (!(await el.count())) return true
  return !(await el.evaluate(n => n.getBoundingClientRect().width > 4))
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
check('agent panel hidden when toggled off', await panelHidden('agent'))
check('agent toggle reflects hidden state', await paneToggle('Agent').evaluate(el => !el.classList.contains('active')))
await paneToggle('Agent').click()
await page.waitForTimeout(300)
check('agent panel reappears when toggled on', await boxVisible('.panel-chat'))

// all main panes can be collapsed (no last-pane guard) — single-pane or empty layout allowed
await paneToggle('Preview').click()
await page.waitForTimeout(300)
await paneToggle('Agent').click()
await page.waitForTimeout(300)
check('preview toggled off', await paneToggle('Preview').evaluate(el => !el.classList.contains('active')))
check('agent toggled off', await paneToggle('Agent').evaluate(el => !el.classList.contains('active')))
check('editor stays active with others off', await paneToggle('Editor').evaluate(el => el.classList.contains('active')))
check('preview panel hidden when toggled off', await panelHidden('preview'))
// collapse editor too: with both inner panes off, the whole center (tabbar + editor) hides
await paneToggle('Editor').click()
await page.waitForTimeout(300)
check('editor can be collapsed with no main pane left', await paneToggle('Editor').evaluate(el => !el.classList.contains('active')))
check('editor hidden when toggled off', await panelHidden('editor'))
check('center hidden when editor+preview are off', await panelHidden('center'))
// even the tree can be collapsed when nothing else is open
await paneToggle('Tree').click()
await page.waitForTimeout(300)
check('tree can be collapsed with all main panes off', await paneToggle('Tree').evaluate(el => !el.classList.contains('active')))
check(
  'nothing visible when all panes collapsed',
  (await panelHidden('tree')) && (await panelHidden('center')) && (await panelHidden('agent'))
)
// restore all panes
await paneToggle('Tree').click()
await paneToggle('Editor').click()
await paneToggle('Preview').click()
await paneToggle('Agent').click()
await page.waitForTimeout(300)
check(
  'panes restored',
  (await boxVisible('.panel-preview')) &&
    (await boxVisible('.panel-chat')) &&
    (await boxVisible('.cm-editor')) &&
    (await boxVisible('.panel-center'))
)

// --- tree hide/show must not refetch: <FileTree> stays mounted (like the agent) ---
await page.waitForTimeout(500) // let any pending watch debounce settle
const treeFetchesBefore = treeFetches
await paneToggle('Tree').click()
await page.waitForTimeout(300)
await paneToggle('Tree').click()
await page.waitForTimeout(300)
check('tree hide/show does not refetch the file tree', treeFetches === treeFetchesBefore)
check('tree reappears instantly after toggle', await boxVisible('.panel-tree'))

// --- layout persists across reload ---
await paneToggle('Agent').click()
await page.waitForTimeout(300)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
check('collapsed agent stays collapsed after reload', await panelHidden('agent'))
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

// hide/show the agent panel must not reconnect the agent (the panel is only
// collapsed, so <Chat> stays mounted and the ACP socket stays open)
const statusBefore = (await page.locator('.chat-status').textContent())?.trim() ?? ''
await paneToggle('Agent').click()
await page.waitForTimeout(300)
await paneToggle('Agent').click()
await page.waitForTimeout(150)
const statusAfter = (await page.locator('.chat-status').textContent())?.trim() ?? ''
check(
  'agent panel hide/show keeps the connection (no reconnect)',
  statusBefore === 'prêt' && statusAfter === 'prêt'
)

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

// --- agent auto-reconnect + message queue ---
// the fake agent exits on the magic prompt '__exit__', so the bridge closes the
// websocket (4000 'agent exited') and the chat must reconnect on its own.
await page.locator('.chat-input').fill('__exit__')
await page.locator('.chat-input').press('Enter')
let dropped = false
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(100)
  const st = (await page.locator('.chat-status').textContent())?.trim() ?? ''
  if (st !== 'prêt') {
    dropped = true
    break
  }
}
check('agent disconnect detected after __exit__', dropped)

// while offline, a message must be queued (not silently dropped)
await page.locator('.chat-input').fill('message hors-ligne')
await page.locator('.chat-input').press('Enter')
let queued = false
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(100)
  const all = (await page.locator('.chat-messages').textContent()) ?? ''
  if (all.includes('en attente')) {
    queued = true
    break
  }
}
check('message sent offline is queued (en attente)', queued)

// the chat must reconnect by itself and get back to 'prêt'
let backToReady = false
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(250)
  const st = (await page.locator('.chat-status').textContent())?.trim() ?? ''
  if (st === 'prêt') {
    backToReady = true
    break
  }
}
check('agent auto-reconnects after a drop', backToReady)

// the queued message is flushed once reconnected and the agent echoes it
let flushed = false
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(250)
  const last = (await page.locator('.chat-messages').textContent()) ?? ''
  if (last.includes('echo: message hors-ligne')) {
    flushed = true
    break
  }
}
check('queued message flushed after reconnect (echo received)', flushed)

// --- workspace selector: fast switcher + open-folder explorer ---
const wsTrigger = page.locator('.topbar .btn', { hasText: '▾' }).first()
const wsItem = text => page.locator('.ws-menu .ws-menu-item', { hasText: text }).first()
await wsTrigger.click()
await page.waitForTimeout(300)
check('fast switcher lists configured workspace', await wsItem('Notes').isVisible())
check('fast switcher lists config workspace', await wsItem('Config').isVisible())
// switch away and back through the dropdown
await wsItem('Config').click()
await page.waitForTimeout(300)
console.log(`  trigger after Config: ${(await wsTrigger.textContent())?.trim()}`)
await wsTrigger.click()
await page.waitForTimeout(300)
await wsItem('Notes').click()
let switchedBack = false
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(300)
  if (/notes/i.test((await wsTrigger.textContent()) ?? '')) {
    switchedBack = true
    break
  }
}
check('switcher switches back to notes workspace', switchedBack)
console.log(`  trigger after notes: ${(await wsTrigger.textContent())?.trim()}`)
// create a brand new workspace from the switcher
const newWsName = `ws-${Date.now()}`
await wsTrigger.click()
await page.waitForTimeout(300)
await wsItem('Nouveau workspace').click()
await page.waitForTimeout(300)
check('switcher offers new-workspace form', await page.locator('.ws-create-input').isVisible())
await page.locator('.ws-create-input').fill(newWsName)
await page.locator('.ws-create .btn.primary').click()
let wsCreated = false
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(300)
  if (new RegExp(newWsName).test((await wsTrigger.textContent()) ?? '')) {
    wsCreated = true
    break
  }
}
check('new workspace created and selected', wsCreated)
await wsTrigger.click()
await page.waitForTimeout(300)
await wsItem('Notes').click()
await page.waitForTimeout(400)
// open the folder-explorer via the dropdown entry
await wsTrigger.click()
await page.waitForTimeout(300)
await wsItem('Ouvrir un dossier').click()
await page.waitForTimeout(400)
check('open-folder modal opens from switcher', await page.locator('.ws-modal').isVisible())
// right-click the browser background (nav bar) -> create a folder at the browse root
await page.locator('.ws-nav').click({ button: 'right' })
await page.waitForTimeout(300)
const newFolderItem = page.locator('.ws-menu-item', { hasText: /^Nouveau dossier$/ }).first()
check('context menu offers new folder', await newFolderItem.isVisible())
await newFolderItem.click()
let folderListed = false
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(300)
  if (await page.locator('.ws-dir', { hasText: /Nouveau dossier/ }).first().isVisible()) {
    folderListed = true
    break
  }
}
check('created folder appears in browser', folderListed)
// open it as a workspace
await page.locator('.ws-actions .btn.primary').click()
let folderOpened = false
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(300)
  if (/nouveau dossier/i.test((await wsTrigger.textContent()) ?? '')) {
    folderOpened = true
    break
  }
}
check('created folder opened as workspace', folderOpened)
// cleanup: close the dialog if it stayed open and switch back
await page.locator('.ws-modal .icon-btn').first().click().catch(() => {})
await wsTrigger.click()
await page.waitForTimeout(300)
await wsItem('Notes').click()
await page.waitForTimeout(400)

await page.screenshot({ path: '/work/ui-result.png', fullPage: true })

await browser.close()
const failed = results.filter(r => !r).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
