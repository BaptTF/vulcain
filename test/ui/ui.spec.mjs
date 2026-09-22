import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE_URL || 'http://127.0.0.1:7399'
const ONLY = process.env.UI_ONLY || ''
const results = []
const check = (name, cond) => {
  results.push(cond)
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`)
}
const toastWithText = async (text, timeout = 5000) => {
  try {
    await page.locator('[data-sonner-toast]', { hasText: text }).first().waitFor({ state: 'visible', timeout })
    return true
  } catch {
    return false
  }
}
const confirmDeleteToast = async (name) => {
  const toast = page.locator('[data-sonner-toast]', { hasText: name }).first()
  await toast.waitFor({ state: 'visible', timeout: 5000 })
  await page.locator('.ws-menu').waitFor({ state: 'hidden', timeout: 2000 }).catch(() => {})
  await toast.locator('button[data-action]').click()
}
const finish = async () => {
  try {
    await page.screenshot({
      path: path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui-result.png'),
      fullPage: true
    })
  } catch {
    // leftover root-owned artefact (e.g. from Docker) must not fail the suite
  }
  await browser.close()
  const failed = results.filter(r => !r).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
}
// a thread can hold several assistant messages; join all rendered markdown
const threadText = async () => (await page.locator('.aui-markdown').allTextContents()).join('\n')

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
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

const paneBoxes = () =>
  page.evaluate(() => {
    const pick = id => {
      const n = document.querySelector(`[data-testid="${id}"]`)
      if (!n) return null
      const r = n.getBoundingClientRect()
      return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom }
    }
    return {
      tree: pick('tree'),
      editor: pick('editor'),
      preview: pick('preview'),
      agent: pick('agent')
    }
  })

const sideBySide = boxes => {
  const order = [boxes.tree, boxes.editor, boxes.preview, boxes.agent]
  if (order.some(b => !b || b.w < 20 || b.h < 40)) return false
  const topSpan = Math.max(...order.map(b => b.y)) - Math.min(...order.map(b => b.y))
  return (
    topSpan < 60 &&
    order[0].x < order[1].x - 8 &&
    order[1].x < order[2].x - 8 &&
    order[2].x < order[3].x - 8
  )
}

const previewStackedUnderEditor = boxes => {
  const e = boxes.editor
  const p = boxes.preview
  if (!e || !p) return false
  return p.y > e.y + e.h * 0.35 && Math.abs(p.x - e.x) < 80
}

const sashRightOf = id =>
  page.evaluate(testId => {
    const el = document.querySelector(`[data-testid="${testId}"]`)
    if (!el) return null
    const r = el.getBoundingClientRect()
    const midY = r.top + r.height / 2
    const sashes = [...document.querySelectorAll('.dv-sash.dv-enabled')]
    let best = null
    let bestDist = Infinity
    for (let i = 0; i < sashes.length; i++) {
      const s = sashes[i]
      const sr = s.getBoundingClientRect()
      if (sr.height < 40 || sr.height < sr.width * 2) continue
      if (sr.bottom < midY || sr.top > midY) continue
      const cx = sr.left + sr.width / 2
      const dist = Math.abs(cx - r.right)
      if (dist < bestDist) {
        bestDist = dist
        best = { i, x: cx, y: midY, dist, cls: s.className }
      }
    }
    return best && best.dist < 24 ? best : null
  }, id)

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
if (ONLY === 'resize') await page.locator('.dv-dockview').first().waitFor({ timeout: 10000 })
else await page.waitForTimeout(2500)

const reactErrors = consoleErrors.filter(e => e.includes('Minified React error'))
check('no minified React error (ex #130)', reactErrors.length === 0)
if (reactErrors.length) console.log('  ->', reactErrors[0].slice(0, 200))
check('no uncaught page error', pageErrors.length === 0)
if (pageErrors.length) console.log('  ->', pageErrors[0])

check('app rendered (topbar)', await page.locator('.topbar .logo').isVisible())
check('dockview workbench mounted', await page.locator('.dv-dockview').first().isVisible())
check('chat panel rendered', await page.locator('.panel-chat .chat-header').isVisible())

// --- default workbench: tree | editor | preview | agent in one row ---
const defaultBoxes = await paneBoxes()
const defaultRow = sideBySide(defaultBoxes)
if (!defaultRow) console.log('  -> default pane boxes', JSON.stringify(defaultBoxes))
check('default layout is tree | editor | preview | agent side by side', defaultRow)
check('preview is not stacked under the editor', !previewStackedUnderEditor(defaultBoxes))

// --- resize: dragging the editor's right sash must stick (no snap-back) ---
const beforeResize = await paneBoxes()
const editorSash = await sashRightOf('editor')
if (!editorSash) console.log('  -> no vertical sash on the editor right edge')
check('editor has a vertical sash on its right edge', !!editorSash)
let editorGrew = false
let resizeStuck = false
let stillRowAfterResize = false
let startW = beforeResize.editor?.w ?? 0
let settled = beforeResize
const topAtSash = editorSash
  ? await page.evaluate(({ x, y }) => {
      const n = document.elementFromPoint(x, y)
      return n ? { tag: n.tagName, cls: n.className } : null
    }, editorSash)
  : null
check(
  'sash is on top at the editor right edge',
  !!topAtSash?.cls?.includes('dv-sash')
)
if (editorSash && !topAtSash?.cls?.includes('dv-sash')) {
  console.log('  -> elementFromPoint at sash', JSON.stringify(topAtSash))
}
const floatingGroupCount = () => page.locator('.dv-render-overlay-float').count()

if (editorSash) {
  startW = beforeResize.editor?.w ?? 0
  // Dockview sashes listen to PointerEvents on document. Playwright's mouse +
  // waitForTimeout between moves drops that pointer (use mouse.move({ steps })
  // for mouse splitters). Keep the whole drag in one gesture: sync moves, then
  // hold the button down past persist debounce, then pointerup.
  const held = await page.evaluate(async ({ i, x, y, dx }) => {
    const sash = document.querySelectorAll('.dv-sash.dv-enabled')[i]
    const editor = document.querySelector('[data-testid="editor"]')
    if (!sash || !editor) return { start: 0, afterSync: 0, mid: 0 }
    const start = editor.getBoundingClientRect().width
    const fire = (target, type, clientX, buttons) => {
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'mouse',
          clientX,
          clientY: y,
          buttons
        })
      )
    }
    fire(sash, 'pointerdown', x, 1)
    const steps = 12
    for (let s = 1; s <= steps; s++) {
      fire(document, 'pointermove', x + (dx * s) / steps, 1)
    }
    const afterSync = editor.getBoundingClientRect().width
    const samples = [afterSync]
    const t0 = performance.now()
    while (performance.now() - t0 < 450) {
      await new Promise(r => requestAnimationFrame(r))
      samples.push(Math.round(editor.getBoundingClientRect().width))
    }
    const mid = editor.getBoundingClientRect().width
    fire(document, 'pointerup', x + dx, 0)
    return { start, afterSync, mid, samples: samples.filter((w, i, a) => i === 0 || w !== a[i - 1]) }
  }, { i: editorSash.i, x: editorSash.x, y: editorSash.y, dx: 120 })
  await page.waitForTimeout(150)
  const justAfter = await paneBoxes()
  await page.waitForTimeout(600)
  settled = await paneBoxes()
  const grewSync = (held?.afterSync ?? 0) >= startW + 40
  const heldWithoutSnap = (held?.mid ?? 0) >= startW + 40
  const grewJustAfter = (justAfter.editor?.w ?? 0) >= startW + 40
  const stayedGrown = (settled.editor?.w ?? 0) >= startW + 40
  const stable = Math.abs((settled.editor?.w ?? 0) - (justAfter.editor?.w ?? 0)) < 20
  editorGrew = grewSync && heldWithoutSnap && grewJustAfter
  resizeStuck = editorGrew && stayedGrown && stable
  stillRowAfterResize = sideBySide(settled)
  if (!resizeStuck || !stillRowAfterResize) {
    console.log(
      '  -> resize',
      JSON.stringify({
        startW,
        held,
        before: beforeResize,
        justAfter,
        settled,
        sash: editorSash,
        topAtSash
      })
    )
  }
}
check('dragging editor right sash widens the editor', editorGrew)
check('editor resize sticks after a long drag (no snap-back)', resizeStuck)
check('layout stays side by side after editor resize', stillRowAfterResize)
check('long sash drag does not float a group', (await floatingGroupCount()) === 0)

let editorReopenKeepsWidth = false
if (resizeStuck) {
  const wide = settled.editor?.w ?? 0
  const editorToggle = page.locator('.viewbar .pane-toggle', { hasText: 'Editor' })
  await editorToggle.click()
  await page.waitForTimeout(350)
  const hidden = await page.evaluate(() => {
    const n = document.querySelector('[data-testid="editor"]')
    return !n || n.getBoundingClientRect().width < 4
  })
  await editorToggle.click()
  await page.waitForTimeout(400)
  const reopened = await paneBoxes()
  const w = reopened.editor?.w ?? 0
  editorReopenKeepsWidth = hidden && w >= startW + 40 && Math.abs(w - wide) < 24
  if (!editorReopenKeepsWidth) {
    console.log('  -> reopen after resize', JSON.stringify({ startW, wide, hidden, reopened }))
  }
}
check('closing and reopening the editor keeps the resized width', editorReopenKeepsWidth)

let siblingToggleKeepsEditor = false
if (editorReopenKeepsWidth) {
  const wide = (await paneBoxes()).editor?.w ?? 0
  const agentToggle = page.locator('.viewbar .pane-toggle', { hasText: 'Agent' })
  await agentToggle.click()
  await page.waitForTimeout(350)
  await agentToggle.click()
  await page.waitForTimeout(400)
  const afterAgent = await paneBoxes()
  const w = afterAgent.editor?.w ?? 0
  siblingToggleKeepsEditor = w >= startW + 40 && Math.abs(w - wide) < 24
  if (!siblingToggleKeepsEditor) {
    console.log('  -> editor after agent toggle', JSON.stringify({ startW, wide, afterAgent }))
  }
}
check('toggling another pane does not reset the editor width', siblingToggleKeepsEditor)

let editorTabXKeepsWidth = false
if (siblingToggleKeepsEditor) {
  const wide = (await paneBoxes()).editor?.w ?? 0
  await page
    .locator('.dv-tab', { hasText: 'Editor' })
    .first()
    .locator('.dv-default-tab-action')
    .click()
  await page.waitForTimeout(350)
  const hidden = await page.evaluate(() => {
    const n = document.querySelector('[data-testid="editor"]')
    if (!n) return true
    const g = n.closest('.dv-groupview')
    return (g || n).getBoundingClientRect().width < 4
  })
  await page.locator('.viewbar .pane-toggle', { hasText: 'Editor' }).click()
  await page.waitForTimeout(400)
  const w = (await paneBoxes()).editor?.w ?? 0
  editorTabXKeepsWidth = hidden && w >= startW + 40 && Math.abs(w - wide) < 24
  if (!editorTabXKeepsWidth) {
    console.log('  -> tab X reopen after resize', JSON.stringify({ startW, wide, hidden, w }))
  }
}
check('closing the editor with the tab X then reopening keeps the resized width', editorTabXKeepsWidth)
if (ONLY === 'resize') await finish()

const row = page.locator('[role="treeitem"]', { hasText: 'welcome.md' })
check('file tree lists welcome.md', await row.first().isVisible())

await row.first().click()
await page.waitForTimeout(800)
const editorVisible = await page.locator('.cm-editor').first().isVisible()
if (!editorVisible) {
  const dump = await page.evaluate(() => {
    const pick = sel => {
      const n = document.querySelector(sel)
      if (!n) return { sel, missing: true }
      const r = n.getBoundingClientRect()
      const s = getComputedStyle(n)
      return {
        sel,
        w: Math.round(r.width),
        h: Math.round(r.height),
        t: Math.round(r.top),
        l: Math.round(r.left),
        display: s.display,
        pos: s.position
      }
    }
    return [
      '.app',
      '.main-panels',
      '.vulcain-dock',
      '.dv-dockview',
      '[data-testid="editor"]',
      '.panel-center',
      '.editor-area',
      '.cm-editor',
      '.cm-content'
    ].map(pick)
  })
  console.log('  -> editor box dump', JSON.stringify(dump))
}
check('editor opens on click', editorVisible)
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
const dndEvent = async ({ type, srcName, dstName, pos = 'center' }) =>
  page.evaluate(
    ({ type, srcName, dstName, pos }) => {
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
          clientY: pos === 'top' ? rect.top + 1 : rect.top + rect.height / 2,
          dataTransfer: new DataTransfer()
        })
      )
      return true
    },
    { type, srcName, dstName, pos }
  )
const dragStart = async name => {
  const ok = await dndEvent({ type: 'dragstart', srcName: name, dstName: name })
  if (ok) await page.waitForTimeout(60) // let react-dnd publish the drag source
  return ok
}
const dragHover = async (srcName, dstName, pos = 'center') => {
  const ok = await dndEvent({ type: 'dragenter', srcName, dstName, pos })
  return ok && (await dndEvent({ type: 'dragover', srcName, dstName, pos }))
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
// hover the top edge of a row to trigger the line cursor (insertion indicator)
check('line cursor hovered', await dragHover(newFileName, 'welcome.md', 'top'))
await page.waitForTimeout(250)
check('drop line shown while dragging', await page.locator('.vulcain-drop-line').isVisible())
check(
  'drop line stays inside the tree panel',
  await page.evaluate(() => {
    const line = document.querySelector('.vulcain-drop-line')
    const panel = document.querySelector('.panel-tree')
    if (!line || !panel) return false
    const lr = line.getBoundingClientRect()
    const pr = panel.getBoundingClientRect()
    return lr.left >= pr.left - 1 && lr.right <= pr.right + 1
  })
)
check('target folder hovered again', await dragHover(newFileName, newFolderName))
await page.waitForTimeout(250)
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
let releaseRename
const renameContinued = new Promise(r => {
  releaseRename = r
})
await page.route('**/api/fs/rename', async route => {
  await new Promise(r => setTimeout(r, 1000))
  await route.continue()
  releaseRename()
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
await renameContinued
await page.unroute('**/api/fs/rename')
await page.waitForTimeout(500) // watch reconcile after the delayed rename
check('optimistic move reconciled on disk', await page.locator('[role="treeitem"]', { hasText: moveFileName }).first().isVisible())

// bring welcome.md back to the foreground so the autosave test below targets it
await row.first().click()
await page.waitForTimeout(300)

// --- autosave: typing should persist to disk after the debounce ---
await page.locator('[data-testid="editor"] .cm-content').first().click()
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
  return await page.evaluate(testId => {
    const n = document.querySelector(`[data-testid="${testId}"]`)
    if (!n) return true
    const group = n.closest('.dv-groupview')
    return (group || n).getBoundingClientRect().width < 4
  }, id)
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
check('editor and preview hidden when both off', (await panelHidden('editor')) && (await panelHidden('preview')))
// even the tree can be collapsed when nothing else is open
await paneToggle('Tree').click()
await page.waitForTimeout(300)
check('tree can be collapsed with all main panes off', await paneToggle('Tree').evaluate(el => !el.classList.contains('active')))
check(
  'nothing visible when all panes collapsed',
  (await panelHidden('tree')) && (await panelHidden('editor')) && (await panelHidden('agent'))
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
const restoredBoxes = await paneBoxes()
const restoredRow = sideBySide(restoredBoxes)
if (!restoredRow) console.log('  -> restored pane boxes', JSON.stringify(restoredBoxes))
check('restored layout is still tree | editor | preview | agent side by side', restoredRow)
check('restored preview is not stacked under the editor', !previewStackedUnderEditor(restoredBoxes))

// --- dockview: close via the tab X, reopen from the viewbar ---
await page.waitForTimeout(500)
const dockTab = title => page.locator('.dv-tab', { hasText: title }).first()
check('dockview workbench is mounted', await page.locator('.dv-dockview').first().isVisible())
check('tree tab exposes a close button', await dockTab('Tree').locator('.dv-default-tab-action').first().isVisible())
await dockTab('Tree').locator('.dv-default-tab-action').first().click()
await page.waitForTimeout(400)
check('tree panel closes from the tab close button', await panelHidden('tree'))
check('tree toggle reflects closed state', await paneToggle('Tree').evaluate(el => !el.classList.contains('active')))
await paneToggle('Tree').click()
await page.waitForTimeout(400)
check('tree reappears from the viewbar', await boxVisible('.panel-tree'))
check('reopened tree still lists welcome.md', await page.locator('[role="treeitem"]', { hasText: 'welcome.md' }).first().isVisible())

// --- layout persists across reload ---
await paneToggle('Agent').click()
await page.waitForTimeout(300)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
check('collapsed agent stays collapsed after reload', await panelHidden('agent'))
await paneToggle('Agent').click()
await page.waitForTimeout(300)
check('agent expandable after reload', await boxVisible('.panel-chat'))

// --- typst preview compiles a sibling PDF and renders it with react-pdf ---
await putFile(
  'page.typ',
  '#set text(font: "Atkinson Hyperlegible")\n#set page(width: 10cm, height: 16cm)\n#align(center)[Typst Page]\n#pagebreak()\n#lorem(40)\n#pagebreak()\n#lorem(40)\n#pagebreak()\n#lorem(40)\n#pagebreak()\n#lorem(40)\n'
)
await page.waitForTimeout(800)
const typRow = page.locator('[role="treeitem"]', { hasText: 'page.typ' }).first()
await typRow.click()
const previewPdf = page.locator('.panel-preview [data-testid="pdf-viewer"]')
const pdfText = async () =>
  (await previewPdf.locator('.pdf-layer:not(.is-hidden) .react-pdf__Page__textContent').allTextContents()).join(' ')
const waitForPdf = async marker => {
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500) // typst WASM compile + react-pdf render
    if ((await previewPdf.locator('.pdf-layer:not(.is-hidden) canvas').count()) && (await pdfText()).includes(marker)) {
      return true
    }
  }
  return false
}
const typFound = await waitForPdf('Typst Page')
check('compiler pdf button is absent', (await page.getByRole('button', { name: 'Compiler PDF' }).count()) === 0)
check('typst preview renders a pdf page', typFound)
if (typFound) {
  const cw = await previewPdf.locator('.pdf-scroll').evaluate(el => el.clientWidth)
  const canvasBox = await previewPdf.locator('canvas').first().boundingBox()
  check('typst pdf page has positive size', !!canvasBox && canvasBox.width > 0 && canvasBox.height > 0)
  check('typst pdf page fits the preview width', !!canvasBox && canvasBox.width > 0 && canvasBox.width <= cw)
  const beforeZoom = canvasBox
  await previewPdf.getByRole('button', { name: 'Zoom in' }).click()
  await page.waitForTimeout(400)
  const zoomed = await previewPdf.locator('canvas').first().boundingBox()
  check('typst pdf zoom in enlarges the page', !!beforeZoom && !!zoomed && zoomed.width > beforeZoom.width + 8)
  await previewPdf.getByRole('button', { name: 'Fit' }).click()
  await page.waitForTimeout(400)
  const fitted = await previewPdf.locator('canvas').first().boundingBox()
  const cwFit = await previewPdf.locator('.pdf-scroll').evaluate(el => el.clientWidth)
  check('typst pdf fit returns to preview width', !!fitted && fitted.width > 0 && fitted.width <= cwFit)
} else {
  check('typst pdf page has positive size', false)
  check('typst pdf page fits the preview width', false)
  check('typst pdf zoom in enlarges the page', false)
  check('typst pdf fit returns to preview width', false)
}
const siblingPdf = await page.evaluate(async () => {
  const ws = localStorage.getItem('vulcain.ws') || ''
  const r = await fetch(`/api/fs/file?ws=${encodeURIComponent(ws)}&path=page.pdf`)
  if (!r.ok) return { ok: false, header: '', disposition: '', type: '', hasAtkinson: false }
  const buf = new Uint8Array(await r.arrayBuffer())
  return {
    ok: true,
    header: new TextDecoder().decode(buf.slice(0, 4)),
    disposition: r.headers.get('content-disposition') || '',
    type: r.headers.get('content-type') || '',
    hasAtkinson: new TextDecoder('latin1').decode(buf).includes('Atkinson')
  }
})
check('typst watch writes a sibling page.pdf', siblingPdf.ok && siblingPdf.header === '%PDF')
check('typst preview embeds Atkinson Hyperlegible', siblingPdf.hasAtkinson)
check(
  'sibling pdf is served inline for the native viewer',
  siblingPdf.type.includes('application/pdf') && siblingPdf.disposition.startsWith('inline')
)
check('file tree lists the sibling pdf', await page.locator('[role="treeitem"]', { hasText: 'page.pdf' }).first().isVisible())

const pdfScroll = previewPdf.locator('.pdf-scroll')
let scrolled = 0
for (let i = 0; i < 25; i++) {
  scrolled = await pdfScroll.evaluate(el => {
    if (el.scrollHeight <= el.clientHeight + 40) return 0
    el.scrollTop = Math.min(240, el.scrollHeight - el.clientHeight)
    return el.scrollTop
  })
  if (scrolled > 80) break
  await page.waitForTimeout(200)
}
check('typst pdf preview is scrollable', scrolled > 80)

await page.locator('.cm-content').click()
await page.keyboard.press('Control+End')
await page.keyboard.type('\nWATCH_PDF_MARKER')
check('typst watch refreshes the pdf after an edit', await waitForPdf('WATCH_PDF_MARKER'))
const scrolledAfter = await pdfScroll.evaluate(el => el.scrollTop)
check('typst pdf keeps scroll after recompile', scrolled > 80 && Math.abs(scrolledAfter - scrolled) < 50)
for (let i = 0; i < 6; i++) {
  await page.keyboard.type(`\nLEAK_CANVAS_${i}`)
  if (!(await waitForPdf(`LEAK_CANVAS_${i}`))) break
}
const canvasCount = await previewPdf.locator('.pdf-layer:not(.is-hidden) canvas').count()
check('typst preview does not accumulate pdf canvases', canvasCount > 0 && canvasCount <= 8)

await putFile('bad.typ', '#definitely_not_a_function[oops]\n')
await page.waitForTimeout(600)
await page.locator('[role="treeitem"]', { hasText: 'bad.typ' }).first().click()
let typErr = false
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(400)
  if (await page.locator('.panel-preview .typ-error').count()) {
    typErr = true
    break
  }
}
check('typst compile error is shown in the preview', typErr)
const pagePdfStillThere = await page.evaluate(async () => {
  const ws = localStorage.getItem('vulcain.ws') || ''
  const r = await fetch(`/api/fs/file?ws=${encodeURIComponent(ws)}&path=page.pdf`)
  if (!r.ok) return false
  const buf = new Uint8Array(await r.arrayBuffer())
  return new TextDecoder().decode(buf.slice(0, 4)) === '%PDF'
})
check('failed compile does not delete the last good sibling pdf', pagePdfStillThere)

await page.locator('[role="treeitem"]', { hasText: 'page.pdf' }).first().click()
let editorPdf = false
for (let i = 0; i < 16; i++) {
  await page.waitForTimeout(250)
  const frame = page.locator('.editor-pdf [data-testid="pdf-frame"]')
  if ((await frame.count()) && (await frame.getAttribute('src') || '').includes('page.pdf')) {
    editorPdf = true
    break
  }
}
check('opening the sibling pdf uses the native pdf viewer', editorPdf)

// --- tab X hides in a shared tab group and the viewbar restores it there ---
const paneTab = id => page.locator(`.dv-tab[data-tab-panel-id="${id}"]`).first()
const tabsShareGroup = async (a, b) =>
  page.evaluate(([x, y]) => {
    const ta = document.querySelector(`.dv-tab[data-tab-panel-id="${x}"]`)
    const tb = document.querySelector(`.dv-tab[data-tab-panel-id="${y}"]`)
    if (!ta || !tb) return false
    return ta.closest('.dv-groupview') === tb.closest('.dv-groupview')
  }, [a, b])
const tabHidden = async id =>
  page.evaluate(panelId => {
    const tab = document.querySelector(`.dv-tab[data-tab-panel-id="${panelId}"]`)
    if (!tab) return true
    const s = getComputedStyle(tab)
    return s.display === 'none' || s.visibility === 'hidden' || tab.classList.contains('vulcain-tab-hidden')
  }, id)
const dockTabOnto = async (srcId, dstId) => {
  const stacked = await page.evaluate(({ srcId, dstId }) => {
    const src = document.querySelector(`.dv-tab[data-tab-panel-id="${srcId}"]`)
    const dst = document.querySelector(`.dv-tab[data-tab-panel-id="${dstId}"]`)
    if (!src || !dst) return false
    const a = src.getBoundingClientRect()
    const b = dst.getBoundingClientRect()
    const from = { x: a.left + a.width / 2, y: a.top + a.height / 2 }
    const to = { x: b.left + Math.min(8, b.width / 2), y: b.top + b.height / 2 }
    const fire = (target, type, clientX, clientY, buttons) => {
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'mouse',
          clientX,
          clientY,
          buttons
        })
      )
    }
    fire(src, 'pointerdown', from.x, from.y, 1)
    const steps = 16
    for (let s = 1; s <= steps; s++) {
      fire(
        document,
        'pointermove',
        from.x + ((to.x - from.x) * s) / steps,
        from.y + ((to.y - from.y) * s) / steps,
        1
      )
    }
    fire(dst, 'pointerup', to.x, to.y, 0)
    fire(document, 'pointerup', to.x, to.y, 0)
    const ta = document.querySelector(`.dv-tab[data-tab-panel-id="${srcId}"]`)
    const tb = document.querySelector(`.dv-tab[data-tab-panel-id="${dstId}"]`)
    return !!ta && !!tb && ta.closest('.dv-groupview') === tb.closest('.dv-groupview')
  }, { srcId, dstId })
  if (!stacked) {
    const srcBox = await paneTab(srcId).boundingBox()
    const dstBox = await paneTab(dstId).boundingBox()
    if (srcBox && dstBox) {
      await page.mouse.move(srcBox.x + srcBox.width / 2, srcBox.y + srcBox.height / 2)
      await page.mouse.down()
      await page.mouse.move(dstBox.x + Math.min(8, dstBox.width / 2), dstBox.y + dstBox.height / 2, {
        steps: 16
      })
      await page.mouse.up()
      await page.waitForTimeout(400)
    }
  } else {
    await page.waitForTimeout(400)
  }
  return tabsShareGroup(srcId, dstId)
}
const editorOnPreview = await dockTabOnto('editor', 'preview')
if (!editorOnPreview) {
  console.log('  -> failed to dock editor onto preview as a tab')
}
check('editor can share a tab group with preview', editorOnPreview)
if (editorOnPreview) {
  await paneTab('editor').locator('.dv-default-tab-action').click()
  await page.waitForTimeout(400)
  check('tab X hides editor without leaving the shared group', await tabHidden('editor'))
  check('preview stays visible after hiding editor in the shared group', await boxVisible('.panel-preview'))
  check(
    'editor toggle reflects hidden state in a shared group',
    await paneToggle('Editor').evaluate(el => !el.classList.contains('active'))
  )
  await paneToggle('Editor').click()
  await page.waitForTimeout(400)
  check('editor tab returns to the same group as preview', await tabsShareGroup('editor', 'preview'))
  check('editor tab is visible again after the viewbar toggle', !(await tabHidden('editor')))
} else {
  check('tab X hides editor without leaving the shared group', false)
  check('preview stays visible after hiding editor in the shared group', false)
  check('editor toggle reflects hidden state in a shared group', false)
  check('editor tab returns to the same group as preview', false)
  check('editor tab is visible again after the viewbar toggle', false)
}

// bring welcome.md back for the chat section below
await page.locator('[role="treeitem"]', { hasText: 'welcome.md' }).first().click()
await page.waitForTimeout(300)

// --- chat: assistant-ui connected to the fake agent via /api/chat ---
let chatStatus = ''
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(1000)
  chatStatus = (await page.locator('.chat-status').textContent())?.trim() ?? ''
  if (chatStatus !== '') break
}
console.log(`  chat status: ${chatStatus}`)
check('chat ready (agent connected)', chatStatus === 'prêt')

// hide/show the agent panel must not reconnect the chat (the panel is only
// collapsed, so <Chat> stays mounted)
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

// sending a message streams the echo back and renders a tool card
await page.locator('.aui-composer-input').fill('ping')
await page.locator('.aui-composer-input').press('Enter')
let echoReceived = false
let toolCardSeen = false
let followUpSeen = false
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(500)
  const text = await threadText()
  if (text.includes('echo: ping')) echoReceived = true
  if (await page.locator('.tool-card').count()) toolCardSeen = true
  if (text.includes('après lecture')) followUpSeen = true
  if (echoReceived && toolCardSeen && followUpSeen) break
}
check('message sent streams the echo back', echoReceived)
check('tool call rendered as a card', toolCardSeen)
const assistantPartsOrder = await page.evaluate(() => {
  const msg = document.querySelector('.aui-msg-assistant')
  if (!msg) return []
  return [...msg.querySelectorAll('.aui-markdown, .tool-card')].map(el =>
    el.classList.contains('tool-card') ? 'tool' : (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  )
})
check(
  'follow-up assistant text renders below the tool card',
  assistantPartsOrder.length >= 3 &&
    assistantPartsOrder[0].includes('echo: ping') &&
    assistantPartsOrder.includes('tool') &&
    assistantPartsOrder.at(-1)?.includes('après lecture') &&
    assistantPartsOrder.findIndex(p => p === 'tool') > 0 &&
    assistantPartsOrder.findIndex(p => p === 'tool') < assistantPartsOrder.length - 1
)
const assistantPartGaps = await page.evaluate(() => {
  const msg = document.querySelector('.aui-msg-assistant')
  if (!msg) return []
  const parts = [...msg.querySelectorAll('.aui-reasoning, :scope .aui-msg-parts > .aui-markdown, .tool-card')]
  const gaps = []
  for (let i = 1; i < parts.length; i++) {
    gaps.push(parts[i].getBoundingClientRect().top - parts[i - 1].getBoundingClientRect().bottom)
  }
  return gaps
})
check(
  'assistant part spacing is uniform',
  assistantPartGaps.length >= 2 &&
    assistantPartGaps.every(g => Math.abs(g - assistantPartGaps[0]) < 1.5) &&
    Math.abs(assistantPartGaps[0] - 10) < 1.5
)

// scroll-to-bottom button: hidden at the bottom, appears once the user scrolls up
// wait for the ping run to complete (composer back to "Envoyer")
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(200)
  if (await page.locator('.aui-composer-actions .btn', { hasText: 'Envoyer' }).isVisible()) break
}
const scrollBtn = page.locator('.aui-scroll-bottom')
check('scroll-to-bottom button hidden at the bottom', !(await scrollBtn.isVisible()))
// a long message overflows the viewport so the button can appear
await page.locator('.aui-composer-input').fill('Ceci est un long message destiné à faire déborder le fil de la zone visible du chat.\n'.repeat(40))
await page.locator('.aui-composer-input').press('Enter')
let longEcho = false
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(300)
  const text = await threadText()
  if (text.includes('Ceci est un long message')) {
    longEcho = true
    break
  }
}
check('long message streams back', longEcho)
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(200)
  if (await page.locator('.aui-composer-actions .btn', { hasText: 'Envoyer' }).isVisible()) break
}
// autoScroll is off (idle CPU); pin to bottom then check the button
await page.evaluate(() => {
  const v = document.querySelector('.aui-viewport')
  if (v) v.scrollTop = v.scrollHeight
})
let scrollBtnHidden = false
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(200)
  if (!(await scrollBtn.isVisible())) {
    scrollBtnHidden = true
    break
  }
}
check('scroll-to-bottom button hides at full scroll', scrollBtnHidden)
// scroll back up -> button reappears
await page.evaluate(() => {
  const v = document.querySelector('.aui-viewport')
  if (v) v.scrollTop = 0
})
let scrollBtnSeen = false
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(200)
  if (await scrollBtn.isVisible()) {
    scrollBtnSeen = true
    break
  }
}
check('scroll-to-bottom button visible after scrolling up', scrollBtnSeen)
await scrollBtn.click()
await page.waitForTimeout(400)
check('scroll-to-bottom button hides after returning to bottom', !(await scrollBtn.isVisible()))

const wsFailures = consoleErrors.filter(e => e.includes('/api/watch'))
check('no websocket connection errors', wsFailures.length === 0)
if (wsFailures.length) console.log('  ->', wsFailures[0].slice(0, 160))

// --- chat sessions: dropdown, action bar, usage bar, thread switching, persistence ---
const sessionsBtn = page.locator('.chat-header .chat-sessions-btn')
const sessionsDropdown = page.locator('.aui-sessions')

check('sessions dropdown hidden by default', (await sessionsDropdown.count()) === 0)
let activeTitleSeen = false
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(200)
  if (((await sessionsBtn.textContent()) ?? '').includes('ping')) {
    activeTitleSeen = true
    break
  }
}
check('header button shows active session title', activeTitleSeen)
check('header button announces popup', (await sessionsBtn.getAttribute('aria-haspopup')) === 'true')
check('header button reflects closed state', (await sessionsBtn.getAttribute('aria-expanded')) === 'false')

// open the dropdown from the header button
await sessionsBtn.click()
await page.waitForTimeout(250)
check('sessions dropdown opens from header button', await sessionsDropdown.isVisible())
check('header button reflects open state', (await sessionsBtn.getAttribute('aria-expanded')) === 'true')
check('first thread listed in dropdown', await page.locator('.aui-session-trigger', { hasText: 'ping' }).first().isVisible())
check(
  'action bar copy button on assistant message',
  await page.locator('.aui-msg-assistant .aui-action-bar button[title="Copier"]').first().isVisible()
)
check('usage bar visible after a message', await page.locator('.aui-usage').isVisible())
const usageLabel = (await page.locator('.aui-usage-label').textContent()) ?? ''
check('usage percent shows two decimal places', /^\d+\.\d{2}%/.test(usageLabel.trim()))

// outside click closes the dropdown
await page.locator('.aui-composer-input').click()
await page.waitForTimeout(250)
check('sessions dropdown closes on outside click', (await sessionsDropdown.count()) === 0)

// Escape closes the dropdown
await sessionsBtn.click()
await page.waitForTimeout(250)
await page.keyboard.press('Escape')
await page.waitForTimeout(250)
check('sessions dropdown closes on Escape', (await sessionsDropdown.count()) === 0)

// the sessions toggle collapses/expands the dropdown
await sessionsBtn.click()
await page.waitForTimeout(250)
check('sessions dropdown shows on toggle', await sessionsDropdown.isVisible())
await sessionsBtn.click()
await page.waitForTimeout(250)
check('sessions dropdown hides on toggle', (await sessionsDropdown.count()) === 0)

// start a second thread from the dropdown
await sessionsBtn.click()
await page.waitForTimeout(250)
await page.locator('.aui-sessions button', { hasText: 'Nouvelle session' }).click()
await page.waitForTimeout(300)
check('dropdown closes after creating a session', (await sessionsDropdown.count()) === 0)

// the second thread is a fresh conversation with its own echo
await page.locator('.aui-composer-input').fill('hello second')
await page.locator('.aui-composer-input').press('Enter')
let secondEcho = false
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(500)
  const text = await threadText()
  if (text.includes('echo: hello second')) {
    secondEcho = true
    break
  }
}
check('second thread streams its own echo', secondEcho)

// the initialized second thread now appears in the dropdown
await sessionsBtn.click()
await page.waitForTimeout(250)
let secondListed = false
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(300)
  if ((await page.locator('.aui-session-item').count()) === 2) {
    secondListed = true
    break
  }
}
check('second thread appears in dropdown', secondListed)

// switching back to the first thread restores its messages (dropdown closes on select)
await page.locator('.aui-session-trigger', { hasText: 'ping' }).first().click()
let firstRestored = false
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(300)
  const text = await threadText()
  if (text.includes('echo: ping') && !text.includes('echo: hello second')) {
    firstRestored = true
    break
  }
}
check('switching back restores first thread messages', firstRestored)
check('dropdown closes after selecting a session', (await sessionsDropdown.count()) === 0)

// both threads persist across a full reload
await page.reload({ waitUntil: 'domcontentloaded' })
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(250)
  const status = (await page.locator('[data-testid="agent"] .chat-status').textContent()) ?? ''
  if (/prêt|en cours|erreur/.test(status)) break
}
await sessionsBtn.click()
await page.waitForTimeout(250)
check('both threads listed after reload', (await page.locator('.aui-session-item').count()) === 2)
let restoredAfterReload = false
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(300)
  const text = await threadText()
  if (text.includes('echo: ping')) {
    restoredAfterReload = true
    break
  }
}
check('last active thread content restored after reload', restoredAfterReload)

// the second thread is still reachable after reload (dropdown is still open)
await page.locator('.aui-session-trigger', { hasText: 'hello second' }).first().click()
let secondRestored = false
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(300)
  const text = await threadText()
  if (text.includes('echo: hello second')) {
    secondRestored = true
    break
  }
}
check('second thread content restored after reload', secondRestored)

await sessionsBtn.click()
await page.waitForTimeout(250)
const extraSession = page.locator('.aui-session-item', { hasText: 'hello second' }).first()
await extraSession.hover()
await extraSession.locator('.aui-session-delete').click()
check('session delete asks for confirmation', await toastWithText('hello second'))
await confirmDeleteToast('hello second')
let sessionDeleted = false
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(200)
  if (!(await page.locator('.aui-session-item', { hasText: 'hello second' }).count())) {
    sessionDeleted = true
    break
  }
}
if (!sessionDeleted) {
  await sessionsBtn.click().catch(() => {})
  await page.waitForTimeout(250)
  sessionDeleted = (await page.locator('.aui-session-item', { hasText: 'hello second' }).count()) === 0
}
check('session delete removes the thread', sessionDeleted)
await page.keyboard.press('Escape')
await page.waitForTimeout(200)

// Escape stops a running agent the same way as the Stop button
await sessionsBtn.click()
await page.waitForTimeout(250)
await page.locator('[data-testid="agent"] .aui-sessions button', { hasText: 'Nouvelle session' }).click()
await page.waitForTimeout(300)
await page.locator('[data-testid="agent"] .aui-composer-input').fill('slow esc-stop')
await page.locator('[data-testid="agent"] .aui-composer-input').press('Enter')
let stopVisible = false
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(100)
  if (await page.locator('[data-testid="agent"] .aui-composer-actions .btn', { hasText: 'Stop' }).isVisible()) {
    stopVisible = true
    break
  }
}
check('Stop button appears while the slow turn runs', stopVisible)
await page.keyboard.press('Escape')
let stoppedByEsc = false
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(150)
  if (await page.locator('[data-testid="agent"] .aui-composer-actions .btn', { hasText: 'Envoyer' }).isVisible()) {
    stoppedByEsc = true
    break
  }
}
check('Escape stops the running agent like Stop', stoppedByEsc)
await page.waitForTimeout(2500)
check(
  'Escape abort does not let the slow turn finish',
  !(await page.locator('[data-testid="agent"] .aui-markdown').allTextContents()).join('\n').includes('après lecture')
)
await page.locator('[data-sonner-toast] button').filter({ hasText: /^×$|^Close$|^Fermer$/ }).first().click({ timeout: 500 }).catch(() => {})
await page.keyboard.press('Escape')
await page.locator('[data-testid="agent"] .aui-composer-input').fill('after esc')
await page.locator('[data-testid="agent"] .aui-composer-input').press('Enter')
let afterEsc = false
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(250)
  const text = (await page.locator('[data-testid="agent"] .aui-markdown').allTextContents()).join('\n')
  if (text.includes('echo: after esc')) {
    afterEsc = true
    break
  }
}
check('sending after Escape abort does not 409', afterEsc)

// dropping the client stream (Stop without aborting the server) must not leave
// the panel blank: session-done reloads the finished turn into the open thread
await sessionsBtn.click()
await page.waitForTimeout(250)
await page.locator('[data-testid="agent"] .aui-sessions button', { hasText: 'Nouvelle session' }).click()
await page.waitForTimeout(300)
await page.locator('[data-testid="agent"] .aui-composer-input').fill('slow catch-up')
await page.locator('[data-testid="agent"] .aui-composer-input').press('Enter')
let catchStop = false
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(100)
  if (await page.locator('[data-testid="agent"] .aui-composer-actions .btn', { hasText: 'Stop' }).isVisible()) {
    catchStop = true
    break
  }
}
check('Stop is visible before dropping the client stream', catchStop)
await page.locator('[data-sonner-toast] button').filter({ hasText: /^×$|^Close$|^Fermer$/ }).first().click({ timeout: 500 }).catch(() => {})
await page.route('**/api/chat/abort', async route => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
})
await page.locator('[data-testid="agent"] .aui-composer-actions .btn', { hasText: 'Stop' }).click({ force: true })
let catchStopped = false
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(150)
  if (await page.locator('[data-testid="agent"] .aui-composer-actions .btn', { hasText: 'Envoyer' }).isVisible()) {
    catchStopped = true
    break
  }
}
check('Stop without server abort returns the composer to Envoyer', catchStopped)
let catchUp = false
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(250)
  const text = (await page.locator('[data-testid="agent"] .aui-markdown').allTextContents()).join('\n')
  if (text.includes('echo: slow catch-up') && text.includes('après lecture')) {
    catchUp = true
    break
  }
}
check('dropped stream still shows the finished turn in the panel', catchUp)
await page.unroute('**/api/chat/abort')

// switching workspace while the agent is answering must not drop the session:
// the turn continues in the background and a toast opens the right thread
await sessionsBtn.click()
await page.waitForTimeout(250)
await page.locator('[data-testid="agent"] .aui-sessions button', { hasText: 'Nouvelle session' }).click()
await page.waitForTimeout(300)
await page.locator('[data-testid="agent"] .aui-composer-input').fill(
  'slow ping\n' + 'ligne pour déborder le fil du chat et vérifier le scroll.\n'.repeat(40)
)
await page.locator('[data-testid="agent"] .aui-composer-input').press('Enter')
await page.waitForTimeout(250)
const switcherBtn = page.locator('.topbar .btn', { hasText: '▾' }).first()
await switcherBtn.click()
await page.waitForTimeout(300)
await page.locator('.ws-menu .ws-menu-item', { hasText: 'Config' }).first().click()
await page.waitForTimeout(400)
check(
  'workspace switcher moved to Config while agent is answering',
  /config/i.test((await switcherBtn.textContent()) ?? '')
)
const doneToast = page.locator('[data-sonner-toast]', { hasText: 'slow ping' })
let toastSeen = false
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(250)
  if (await doneToast.isVisible()) {
    toastSeen = true
    break
  }
}
check('toast appears when a background session finishes', toastSeen)
if (toastSeen) await doneToast.getByRole('button', { name: 'Ouvrir' }).click()
let backOnNotes = false
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(250)
  if (/notes/i.test((await switcherBtn.textContent()) ?? '')) {
    backOnNotes = true
    break
  }
}
check('clicking the toast returns to the session workspace', backOnNotes)
let backgroundRestored = false
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(300)
  const text = (await page.locator('[data-testid="agent"] .aui-markdown').allTextContents()).join('\n')
  if (text.includes('echo: slow ping') && text.includes('après lecture')) {
    backgroundRestored = true
    break
  }
}
check('toast opens the session that finished in the background', backgroundRestored)
let scrolledToEnd = false
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(150)
  const pos = await page.locator('[data-testid="agent"] .aui-viewport').evaluate(el => ({
    top: el.scrollTop,
    client: el.clientHeight,
    height: el.scrollHeight
  }))
  if (pos.height > pos.client + 40 && pos.top + pos.client >= pos.height - 16) {
    scrolledToEnd = true
    break
  }
}
check('toast opens the session scrolled to the end', scrolledToEnd)

// --- workspace selector: fast switcher + open-folder explorer ---
const wsTrigger = page.locator('.topbar .btn', { hasText: '▾' }).first()
const wsItem = text => page.locator('.ws-menu .ws-menu-item', { hasText: text }).first()
await wsTrigger.click()
await page.waitForTimeout(300)
check('fast switcher lists configured workspace', await wsItem('Notes').isVisible())
check('fast switcher lists config workspace', await wsItem('Config').isVisible())
// switch away and back through the dropdown
await wsItem('Config').click()
await page.waitForTimeout(500)
console.log(`  trigger after Config: ${(await wsTrigger.textContent())?.trim()}`)
const notesTabsAfterSwitch = await page.evaluate(() => localStorage.getItem('vulcain.tabs.Notes'))
const configTabsAfterSwitch = await page.evaluate(() => localStorage.getItem('vulcain.tabs.__config__'))
check(
  'notes tabs stay stored under Notes after switch',
  !!notesTabsAfterSwitch && notesTabsAfterSwitch.includes('welcome.md')
)
check(
  'config tabs do not include files from Notes',
  !configTabsAfterSwitch?.includes('welcome.md')
)
check(
  'welcome.md tab is not open in the other workspace',
  (await page.locator('.tab', { hasText: 'welcome.md' }).count()) === 0
)

const file500s = []
const leakedWelcomeReads = []
const onSwitchResp = r => {
  if (r.url().includes('/api/fs/file') && r.status() >= 500) file500s.push(`${r.status()} ${r.url()}`)
}
const onSwitchReq = r => {
  if (r.url().includes('/api/fs/file') && r.url().includes('welcome.md') && r.url().includes('__config__')) {
    leakedWelcomeReads.push(r.url())
  }
}
page.on('response', onSwitchResp)
page.on('request', onSwitchReq)

await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
check('reload after workspace switch keeps the app up', await page.locator('.topbar .logo').isVisible())
check('still on config workspace after reload', /config/i.test((await wsTrigger.textContent()) ?? ''))
check('reload does not 500 on files from the previous workspace', file500s.length === 0)
if (file500s.length) console.log('  ->', file500s[0])
check('reload does not fetch Notes files from Config', leakedWelcomeReads.length === 0)
check(
  'welcome.md tab still absent after reload in config',
  (await page.locator('.tab', { hasText: 'welcome.md' }).count()) === 0
)
page.off('response', onSwitchResp)
page.off('request', onSwitchReq)

await wsTrigger.click()
await page.waitForTimeout(300)
await wsItem('Notes').click()
let notesTabRestored = false
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(300)
  if ((await page.locator('.tab', { hasText: 'welcome.md' }).count()) > 0) {
    notesTabRestored = true
    break
  }
}
check('welcome.md tab restored when returning to Notes', notesTabRestored)
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
await wsTrigger.click()
await page.waitForTimeout(300)
await page.locator('.ws-menu-row', { hasText: newWsName }).locator('.ws-menu-remove').click()
check('workspace delete asks for confirmation', await toastWithText(newWsName))
await confirmDeleteToast(newWsName)
check('workspace delete confirmation succeeded', await toastWithText(`« ${newWsName} » retiré`))
await page.keyboard.press('Escape').catch(() => {})
await page.waitForTimeout(200)
await wsTrigger.click()
await page.locator('.ws-menu').waitFor({ state: 'visible', timeout: 3000 })
const wsStillListed = await page.locator('.ws-menu .ws-menu-row', { hasText: newWsName }).count()
check('workspace delete removes it from the switcher', wsStillListed === 0)
await page.keyboard.press('Escape')
await page.waitForTimeout(200)
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

await finish()
