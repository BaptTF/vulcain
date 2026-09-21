#!/usr/bin/env node
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL || 'http://127.0.0.1:7397'
const IDLE_MS = Number(process.env.IDLE_MS || 3000)

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()

await page.addInitScript(() => {
  const g = { raf: 0, timeout: 0, interval: 0, ro: 0, mo: 0, stacks: {} }
  window.__idleHooks = g
  const raf = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = cb => {
    g.raf++
    return raf(cb)
  }
  const sto = window.setTimeout.bind(window)
  window.setTimeout = (cb, ms, ...args) => {
    g.timeout++
    return sto(cb, ms, ...args)
  }
  const siv = window.setInterval.bind(window)
  window.setInterval = (cb, ms, ...args) => {
    g.interval++
    const key = `interval ${ms}ms`
    g.stacks[key] = (g.stacks[key] || 0) + 1
    return siv(cb, ms, ...args)
  }
  const RO = window.ResizeObserver
  window.ResizeObserver = class extends RO {
    constructor(cb) {
      super((entries, obs) => {
        g.ro++
        for (const e of entries) {
          const t = e.target
          const id =
            t.getAttribute?.('data-testid') ||
            (typeof t.className === 'string' ? t.className.split(' ')[0] : t.tagName) ||
            t.tagName
          g.stacks['ro:' + id] = (g.stacks['ro:' + id] || 0) + 1
          const box = `${Math.round(e.contentRect.width)}x${Math.round(e.contentRect.height)}`
          g.stacks['size:' + box] = (g.stacks['size:' + box] || 0) + 1
        }
        return cb(entries, obs)
      })
    }
  }
  const MO = window.MutationObserver
  window.MutationObserver = class extends MO {
    constructor(cb) {
      super((...a) => {
        g.mo++
        return cb(...a)
      })
    }
  }
})

const putFile = (filePath, content) =>
  page.evaluate(
    async ({ path: p, content: c }) => {
      const ws = localStorage.getItem('vulcain.ws') || ''
      const r = await fetch('/api/fs/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ws, path: p, content: c })
      })
      if (!r.ok) throw new Error('PUT failed: ' + r.status)
    },
    { path: filePath, content }
  )

const metricMap = metrics => Object.fromEntries(metrics.map(m => [m.name, m.value]))

const sampleIdle = async label => {
  await page.evaluate(() => {
    const g = window.__idleHooks
    g.raf = 0
    g.timeout = 0
    g.interval = 0
    g.ro = 0
    g.mo = 0
    g.stacks = {}
  })

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const before = metricMap((await cdp.send('Performance.getMetrics')).metrics)
  const t0 = Date.now()
  await page.waitForTimeout(IDLE_MS)
  const after = metricMap((await cdp.send('Performance.getMetrics')).metrics)
  const wall = (Date.now() - t0) / 1000
  const delta = name => Math.max(0, (after[name] || 0) - (before[name] || 0))
  const task = delta('TaskDuration')
  const script = delta('ScriptDuration')
  const layout = delta('LayoutDuration')
  const style = delta('RecalcStyleDuration')
  const hooks = await page.evaluate(() => ({ ...window.__idleHooks }))

  console.log(`\n== ${label} (${IDLE_MS}ms idle) ==`)
  console.log(
    `  CPU  task=${((task / wall) * 100).toFixed(2)}%  script=${((script / wall) * 100).toFixed(2)}%  layout=${((layout / wall) * 100).toFixed(2)}%  style=${((style / wall) * 100).toFixed(2)}%`
  )
  console.log(
    `  rAF=${hooks.raf} (${(hooks.raf / (IDLE_MS / 1000)).toFixed(1)}/s)  timeouts=${hooks.timeout}  intervals=${hooks.interval}  ResizeObserver=${hooks.ro}  MutationObserver=${hooks.mo}`
  )
  const stackTop = Object.entries(hooks.stacks || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
  if (stackTop.length) {
    console.log('  intervals:')
    for (const [s, n] of stackTop) console.log(`    ${String(n).padStart(4)}  ${s.slice(0, 220)}`)
  }

  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 })
  await cdp.send('Profiler.start')
  await page.waitForTimeout(1500)
  const { profile } = await cdp.send('Profiler.stop')
  const byId = new Map((profile.nodes || []).map(n => [n.id, n]))
  const hits = new Map()
  for (const id of profile.samples || []) {
    const node = byId.get(id)
    if (!node) continue
    const call = node.callFrame || {}
    const url = String(call.url || '')
    if (url.startsWith('pptr:') || url.includes('__playwright')) continue
    const name = `${call.functionName || '(anonymous)'} @ ${url}:${call.lineNumber ?? -1}`
    hits.set(name, (hits.get(name) || 0) + 1)
  }
  const top = [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  if (top.length) {
    console.log('  profiler (1.5s, 1ms samples):')
    for (const [name, n] of top) console.log(`    ${String(n).padStart(4)}  ${name.slice(0, 220)}`)
  }

  await cdp.detach()
  const viewportRo = hooks.stacks?.['ro:aui-viewport'] || 0
  const roPerSec = viewportRo / (IDLE_MS / 1000)
  if (roPerSec > 10) {
    console.log(`  FAIL aui-viewport ResizeObserver ${roPerSec.toFixed(1)}/s (idle should be ~0)`)
    failed = true
  }
  return { label, taskPct: (task / wall) * 100, rafPerSec: hooks.raf / (IDLE_MS / 1000), hooks }
}

let failed = false

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.locator('.topbar .logo').waitFor({ timeout: 15000 })
await page.waitForTimeout(1500)

await sampleIdle('markdown welcome (all panes)')

const agentToggle = page.locator('.viewbar .pane-toggle', { hasText: 'Agent' })
await agentToggle.click()
await page.waitForTimeout(400)
await sampleIdle('markdown welcome (agent hidden)')
await agentToggle.click()
await page.waitForTimeout(400)

await putFile(
  'idle.typ',
  '#set text(font: "Atkinson Hyperlegible")\n#set page(width: 10cm, height: 16cm)\n= Idle\n#lorem(80)\n#pagebreak()\n#lorem(80)\n'
)
await page.locator('[role="treeitem"]', { hasText: 'idle.typ' }).first().waitFor({ timeout: 10000 })
await page.locator('[role="treeitem"]', { hasText: 'idle.typ' }).first().click()
await page.waitForFunction(() => {
  const layer = document.querySelector('.panel-preview .pdf-layer:not(.is-hidden)')
  return !!(layer && layer.querySelector('canvas'))
}, { timeout: 20000 })
await page.waitForTimeout(800)
await sampleIdle('typst preview idle (2 pages)')

await browser.close()
process.exit(failed ? 1 : 0)
