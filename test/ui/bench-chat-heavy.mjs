#!/usr/bin/env node
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL || 'http://127.0.0.1:7396'
const WS = process.env.BENCH_WS || 'Notes'
const SCALES = (process.env.SCALES || '20,80,200')
  .split(',')
  .map(s => Number(s.trim()))
  .filter(n => n > 0)
const SESSION_ID = 'bench-heavy'
const CODE = [
  'function parseConversation(turns) {',
  '  const out = []',
  '  for (const turn of turns) {',
  '    const text = String(turn.body || "")',
  '    out.push({ id: turn.id, n: text.length })',
  '  }',
  '  return out',
  '}',
  '',
  ...Array.from({ length: 24 }, (_, i) => `const sample${i} = parseConversation([{ id: ${i}, body: "x".repeat(${20 + i}) }])`)
].join('\n')

function percentile(values, p) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[idx]
}

function mean(values) {
  if (!values.length) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

function fmt(n, digits = 0) {
  if (n == null || Number.isNaN(n)) return '   n/a'
  return n.toFixed(digits).padStart(7)
}

function userText(i) {
  return `Tour ${i + 1}: résume le point précédent et donne un exemple concret.`
}

function assistantParts(i) {
  const withCode = i % 4 === 0
  const withTool = i % 5 === 0
  const body = [
    `## Réponse ${i + 1}`,
    '',
    'Voici un développement un peu long pour alourdir le fil : listes, markdown et parfois du code.',
    '',
    '- hypothèse A',
    '- hypothèse B',
    '- hypothèse C',
    '',
    withCode ? `\`\`\`js\n${CODE}\n\`\`\`\n` : 'Un paragraphe intermédiaire sans fence, pour varier le coût markdown-it / highlight.js.\n',
    'Conclusion du tour, avec **gras** et un [lien](https://example.com).'
  ].join('\n')
  const parts = [{ type: 'text', text: body }]
  if (withTool) {
    parts.push({
      type: 'tool-read',
      toolCallId: `read-${i}`,
      toolName: 'read',
      state: 'output-available',
      input: { path: 'welcome.md' },
      output: 'file contents here '.repeat(24)
    })
    parts.push({ type: 'text', text: 'après lecture du fichier.' })
  }
  return parts
}

function makeRepo(turns) {
  const messages = []
  let parent = null
  let headId = null
  for (let i = 0; i < turns; i += 1) {
    const uid = `user-${i}`
    const aid = `asst-${i}`
    messages.push({
      id: uid,
      parent_id: parent,
      format: 'ai-sdk/v6',
      content: { role: 'user', parts: [{ type: 'text', text: userText(i) }] }
    })
    messages.push({
      id: aid,
      parent_id: uid,
      format: 'ai-sdk/v6',
      content: { role: 'assistant', parts: assistantParts(i) }
    })
    parent = aid
    headId = aid
  }
  return { headId, messages }
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json = {}
  try {
    json = JSON.parse(text || '{}')
  } catch {
    json = { raw: text }
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 240)}`)
  return json
}

async function seed(turns) {
  const repo = makeRepo(turns)
  await api('PUT', `/api/chat/sessions/${SESSION_ID}`, { workspace: WS, title: `Bench ${turns} tours` })
  await api('PUT', `/api/chat/sessions/${SESSION_ID}/messages`, {
    workspace: WS,
    headId: repo.headId,
    messages: repo.messages
  })
  await api('PUT', '/api/chat/active', { workspace: WS, sessionId: SESSION_ID })
  return repo.messages.length
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.setDefaultTimeout(60000)

await page.addInitScript(() => {
  window.__benchLongTasks = []
  try {
    const obs = new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        window.__benchLongTasks.push({ dur: e.duration, start: e.startTime, name: e.name })
      }
    })
    obs.observe({ type: 'longtask', buffered: true })
  } catch {}
})

async function openHeavy(turns) {
  try {
    await page.evaluate(() => {
      window.__benchLongTasks = []
    })
  } catch {}
  const needle = `Tour ${turns}:`
  const t0 = Date.now()
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.locator('.topbar .logo').waitFor({ timeout: 15000 })
  const deadline = Date.now() + 120000
  let ready = false
  let lastLog = 0
  while (Date.now() < deadline) {
    ready = await page.evaluate(n => {
      const agent = document.querySelector('[data-testid="agent"]')
      if (!agent) return false
      return [...agent.querySelectorAll('.aui-user-bubble')].some(el => (el.textContent || '').includes(n))
    }, needle)
    if (ready) break
    if (Date.now() - lastLog > 2000) {
      const mounted = await page.evaluate(
        () => document.querySelectorAll('[data-testid="agent"] .aui-msg').length
      )
      console.log(`    waiting… last turn "${needle}" (mounted ${mounted}) at ${Date.now() - t0}ms`)
      lastLog = Date.now()
    }
    await page.waitForTimeout(250)
  }
  const openMs = Date.now() - t0
  if (!ready) throw new Error(`last turn "${needle}" not in view after ${openMs}ms`)
  return { openMs }
}

async function snapshotDom() {
  return page.locator('[data-testid="agent"]').evaluate(root => {
    const viewport = root.querySelector('.aui-viewport')
    return {
      messages: root.querySelectorAll('.aui-msg').length,
      markdown: root.querySelectorAll('.aui-markdown').length,
      code: root.querySelectorAll('pre, .hljs').length,
      nodes: root.querySelectorAll('*').length,
      htmlKB: Math.round(root.innerHTML.length / 1024),
      scrollHeight: viewport?.scrollHeight ?? 0,
      clientHeight: viewport?.clientHeight ?? 0,
      scrollTop: viewport?.scrollTop ?? 0
    }
  })
}

async function measureScroll() {
  return page.evaluate(async () => {
    const el = document.querySelector('[data-testid="agent"] .aui-viewport')
    if (!el) return { error: 'no viewport' }
    const frames = []
    let last = performance.now()
    let recording = true
    const onFrame = now => {
      if (!recording) return
      frames.push(now - last)
      last = now
      requestAnimationFrame(onFrame)
    }
    const afterPaint = () =>
      new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())))
      })
    const jump0 = performance.now()
    el.scrollTop = 0
    const jumpTopMs = (await afterPaint()) - jump0
    const jump1 = performance.now()
    el.scrollTop = el.scrollHeight
    const jumpBottomMs = (await afterPaint()) - jump1

    last = performance.now()
    requestAnimationFrame(onFrame)
    const start = performance.now()
    const duration = 1000
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    await new Promise(resolve => {
      const step = now => {
        const t = Math.min(1, (now - start) / duration)
        el.scrollTop = max * (1 - t)
        if (t < 1) requestAnimationFrame(step)
        else resolve()
      }
      requestAnimationFrame(step)
    })
    recording = false
    await new Promise(r => requestAnimationFrame(r))
    const dts = frames.filter(dt => dt > 0 && dt < 1000)
    const dropped = dts.filter(dt => dt > 24).length
    return {
      jumpTopMs,
      jumpBottomMs,
      overflow: max,
      rafCount: dts.length,
      rafMsMean: dts.length ? dts.reduce((a, b) => a + b, 0) / dts.length : null,
      rafMsP95: dts.length
        ? [...dts].sort((a, b) => a - b)[Math.min(dts.length - 1, Math.ceil(0.95 * dts.length) - 1)]
        : null,
      droppedFrames: dropped
    }
  })
}

async function measureTyping() {
  await page.evaluate(() => {
    window.__typeLat = []
    const el = document.querySelector('[data-testid="agent"] .aui-composer-input')
    if (!el) return
    el.addEventListener('keydown', () => {
      window.__kd = performance.now()
    })
    el.addEventListener('input', () => {
      if (typeof window.__kd === 'number') window.__typeLat.push(performance.now() - window.__kd)
    })
  })
  const input = page.locator('[data-testid="agent"] .aui-composer-input')
  await input.click()
  await input.fill('')
  await input.pressSequentially('hello lag check 12345', { delay: 20 })
  const samples = await page.evaluate(() => window.__typeLat || [])
  return {
    n: samples.length,
    meanMs: mean(samples),
    p95Ms: percentile(samples, 95),
    maxMs: samples.length ? Math.max(...samples) : null
  }
}

async function measureStream() {
  await page.evaluate(() => {
    window.__benchLongTasks = []
  })
  const input = page.locator('[data-testid="agent"] .aui-composer-input')
  const payload = 'slow bench\n' + 'ligne de stream pour reparser le markdown.\n'.repeat(30) + '```js\n' + CODE + '\n```\n'
  await input.fill(payload)
  const t0 = Date.now()
  await input.press('Enter')
  let firstTokenMs = null
  for (let i = 0; i < 80; i += 1) {
    await page.waitForTimeout(50)
    const seen = await page.locator('[data-testid="agent"] .aui-markdown').evaluateAll(nodes =>
      nodes.some(n => /echo: slow bench/.test(n.textContent || ''))
    )
    if (seen) {
      firstTokenMs = Date.now() - t0
      break
    }
  }
  const streamDeadline = Date.now() + 20000
  let finished = false
  while (Date.now() < streamDeadline) {
    const text = (await page.locator('[data-testid="agent"] .aui-markdown').allTextContents()).join('\n')
    if (text.includes('après lecture') && /echo: slow bench/.test(text)) {
      finished = true
      break
    }
    await page.waitForTimeout(200)
  }
  if (!finished) throw new Error('slow turn did not finish')
  const doneMs = Date.now() - t0
  const longTasks = await page.evaluate(() => window.__benchLongTasks || [])
  const longMs = longTasks.reduce((a, t) => a + (t.dur || 0), 0)
  return {
    firstTokenMs,
    doneMs,
    longTaskCount: longTasks.length,
    longTaskMs: longMs,
    longTaskMax: longTasks.length ? Math.max(...longTasks.map(t => t.dur)) : 0
  }
}

page.on('pageerror', err => console.log('  pageerror:', err.message))
page.on('crash', () => console.log('  crash: renderer died'))

const rows = []
let failed = false

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.locator('.topbar .logo').waitFor({ timeout: 15000 })
  await page.waitForTimeout(500)

  for (const turns of SCALES) {
    console.log(`\n== ${turns} turns (${turns * 2} messages) ==`)
    const stored = await seed(turns)
    const { openMs } = await openHeavy(turns)
    const dom = await snapshotDom()
    const scroll = await measureScroll()
    const typing = await measureTyping()
    const longTasks = await page.evaluate(() => window.__benchLongTasks || [])
    const row = {
      turns,
      messages: stored,
      openMs,
      ...dom,
      ...scroll,
      typeMean: typing.meanMs,
      typeP95: typing.p95Ms,
      typeMax: typing.maxMs,
      longTaskCount: longTasks.length,
      longTaskMs: longTasks.reduce((a, t) => a + (t.dur || 0), 0)
    }
    if (turns === SCALES[SCALES.length - 1]) {
      console.log('  streaming a slow turn on top of the heavy thread…')
      const stream = await measureStream()
      Object.assign(row, {
        streamFirstMs: stream.firstTokenMs,
        streamDoneMs: stream.doneMs,
        streamLongN: stream.longTaskCount,
        streamLongMs: stream.longTaskMs,
        streamLongMax: stream.longTaskMax
      })
      console.log(
        `  stream first=${fmt(stream.firstTokenMs)}ms  done=${fmt(stream.doneMs)}ms  longTasks=${stream.longTaskCount} (${fmt(stream.longTaskMs)}ms, max ${fmt(stream.longTaskMax)}ms)`
      )
    }
    rows.push(row)
    console.log(
      `  open=${fmt(openMs)}ms  mounted=${dom.messages}/${stored}  nodes=${dom.nodes}  html=${dom.htmlKB}KB  overflow=${dom.scrollHeight - dom.clientHeight}px`
    )
    console.log(
      `  scroll jumpTop=${fmt(scroll.jumpTopMs, 2)}ms jumpBottom=${fmt(scroll.jumpBottomMs, 2)}ms  rAF mean=${fmt(scroll.rafMsMean, 1)}ms p95=${fmt(scroll.rafMsP95, 1)}ms dropped>${24}ms: ${scroll.droppedFrames}`
    )
    console.log(
      `  type mean=${fmt(typing.meanMs, 1)}ms p95=${fmt(typing.p95Ms, 1)}ms max=${fmt(typing.maxMs, 1)}ms  longTasks=${longTasks.length}`
    )
    if (turns >= 80 && dom.messages >= stored / 2) {
      failed = true
      console.log(`  FAIL virtualization: mounted ${dom.messages} of ${stored} messages`)
    }
  }
} catch (err) {
  failed = true
  console.error('\nFAIL', err.message || err)
}

console.log('\n== summary ==')
console.log(
  'turns  open_ms  nodes   htmlKB  jump_ms  raf_p95  type_p95  stream_first  stream_done'
)
for (const r of rows) {
  console.log(
    `${String(r.turns).padStart(5)} ${fmt(r.openMs)} ${fmt(r.nodes)} ${fmt(r.htmlKB)} ${fmt(r.jumpBottomMs, 1)} ${fmt(r.rafMsP95, 1)} ${fmt(r.typeP95, 1)} ${fmt(r.streamFirstMs)} ${fmt(r.streamDoneMs)}`
  )
}

await browser.close()
process.exit(failed ? 1 : 0)
