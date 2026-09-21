#!/usr/bin/env node
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL || 'http://127.0.0.1:7398'
const ROUNDS = Math.max(3, Number(process.env.BENCH_ROUNDS || 8))
const WARMUP = Math.min(2, ROUNDS - 1)

const DOC = `#set text(font: "Atkinson Hyperlegible")
#set page(width: 10cm, height: 16cm)
= Preview bench
#lorem(80)
#pagebreak()
#lorem(80)
`

const stats = xs => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  return { min: s[0], median, max: s[s.length - 1], mean }
}

const fmt = n => (n == null || Number.isNaN(n) ? '   n/a' : String(Math.round(n)).padStart(6))

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

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

const waitForPdf = async (marker, timeoutMs = 20000) => {
  try {
    await page.waitForFunction(
      m => {
        const layer = document.querySelector('.panel-preview .pdf-layer:not(.is-hidden)')
        if (!layer?.querySelector('canvas')) return false
        const text = [...layer.querySelectorAll('.react-pdf__Page__textContent')].map(el => el.textContent || '').join(' ')
        return text.includes(m)
      },
      marker,
      { timeout: timeoutMs }
    )
    return true
  } catch {
    return false
  }
}

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.locator('.topbar .logo').waitFor({ timeout: 15000 })

await putFile('bench.typ', DOC)
await page.locator('[role="treeitem"]', { hasText: 'bench.typ' }).first().waitFor({ timeout: 10000 })
await page.locator('[role="treeitem"]', { hasText: 'bench.typ' }).first().click()

if (!(await waitForPdf('Preview bench'))) {
  console.error('initial Typst preview did not render')
  await browser.close()
  process.exit(1)
}

const samples = []

for (let i = 0; i < ROUNDS; i++) {
  const marker = `BENCH${i}_${Math.random().toString(16).slice(2, 8)}`
  await page.evaluate(() => {
    window.__vulcainTypst = {}
  })
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(`\n${marker}`)
  const t0 = await page.evaluate(() => {
    const now = performance.now()
    window.__vulcainTypst = { ...window.__vulcainTypst, t0: now }
    return now
  })

  if (!(await waitForPdf(marker))) {
    console.error(`timeout waiting for ${marker}`)
    await browser.close()
    process.exit(1)
  }

  const row = await page.evaluate(start => {
    const t1 = performance.now()
    const t = window.__vulcainTypst || {}
    const delta = (a, b) => (a && b ? b - a : null)
    return {
      total: t1 - start,
      debounce: t.compileStart && start ? Math.max(0, t.compileStart - start) : null,
      compile: delta(t.compileStart, t.compileEnd),
      parse: delta(t.bytesSet, t.pdfParsed),
      paint: delta(t.pdfParsed, t.layerReady),
      render: delta(t.bytesSet, t.layerReady)
    }
  }, t0)
  samples.push(row)
  console.log(
    `${i < WARMUP ? 'warm' : 'run '} ${String(i + 1).padStart(2)}  total${fmt(row.total)}  debounce${fmt(row.debounce)}  compile${fmt(row.compile)}  parse${fmt(row.parse)}  paint${fmt(row.paint)}  render${fmt(row.render)}`
  )
}

const steady = samples.slice(WARMUP)
const keys = ['total', 'debounce', 'compile', 'parse', 'paint', 'render']
console.log('\nTypst preview: last keystroke → visible PDF text (2-page Atkinson)')
console.log(`discarded ${WARMUP} warmup, ${steady.length} steady samples`)
for (const key of keys) {
  const xs = steady.map(s => s[key]).filter(n => n != null)
  if (!xs.length) continue
  const s = stats(xs)
  console.log(
    `  ${key.padEnd(8)}  min${fmt(s.min)}  median${fmt(s.median)}  mean${fmt(s.mean)}  max${fmt(s.max)}`
  )
}

await browser.close()
process.exit(0)
