#!/usr/bin/env node
import fs from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL || 'http://127.0.0.1:7397'
const IDLE_MS = Number(process.env.IDLE_MS || 5000)
const CLK = 100

function readStat(pid) {
  const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  const rest = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
  return {
    ticks: Number(rest[11]) + Number(rest[12]),
    rss: Number(rest[21]) * 4096
  }
}

function cmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ')
  } catch {
    return ''
  }
}

function ppidOf(pid) {
  const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  return Number(raw.slice(raw.lastIndexOf(')') + 2).split(' ')[1])
}

function descendants(root) {
  const kids = new Map()
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    try {
      const ppid = ppidOf(pid)
      if (!kids.has(ppid)) kids.set(ppid, [])
      kids.get(ppid).push(pid)
    } catch {}
  }
  const out = []
  const stack = [root]
  while (stack.length) {
    const pid = stack.pop()
    out.push(pid)
    for (const child of kids.get(pid) || []) stack.push(child)
  }
  return out
}

function classify(pid) {
  const cmd = cmdline(pid)
  if (cmd.includes('--type=renderer')) return 'renderer'
  if (cmd.includes('--type=gpu-process')) return 'gpu'
  if (cmd.includes('--type=utility')) return 'utility'
  if (cmd.includes('--type=zygote')) return 'zygote'
  return 'other'
}

function familyByType(rootPid) {
  const groups = { renderer: [], gpu: [], utility: [], other: [] }
  for (const pid of descendants(rootPid)) {
    const kind = classify(pid)
    if (kind === 'zygote') continue
    if (!groups[kind]) groups[kind] = []
    groups[kind].push(pid)
  }
  return groups
}

function snapshot(pids) {
  const out = new Map()
  for (const pid of pids) {
    try {
      out.set(pid, readStat(pid))
    } catch {}
  }
  return out
}

function cpuPct(before, after, wallSec, pids) {
  let ticks = 0
  let rss = 0
  for (const pid of pids) {
    const a = after.get(pid)
    const b = before.get(pid)
    if (!a || !b) continue
    ticks += a.ticks - b.ticks
    rss += a.rss
  }
  return { pct: (ticks / (wallSec * CLK)) * 100, rss }
}

function readThreads(pids) {
  const out = new Map()
  for (const pid of pids) {
    let tasks
    try {
      tasks = fs.readdirSync(`/proc/${pid}/task`)
    } catch {
      continue
    }
    for (const tid of tasks) {
      try {
        const raw = fs.readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8')
        const comm = raw.slice(raw.indexOf('(') + 1, raw.lastIndexOf(')'))
        const rest = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
        out.set(`${pid}:${tid}`, { comm, ticks: Number(rest[11]) + Number(rest[12]) })
      } catch {}
    }
  }
  return out
}

function childrenOf(pid) {
  const out = []
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    const child = Number(name)
    try {
      if (ppidOf(child) === pid) out.push(child)
    } catch {}
  }
  return out
}

function findBrowserPid() {
  const kids = childrenOf(process.pid)
  const chrome = kids.find(pid => /chrom/i.test(cmdline(pid)))
  if (chrome) return chrome
  throw new Error(
    `no chromium child of ${process.pid}; kids=${kids.map(p => `${p}:${cmdline(p).slice(0, 80)}`).join(' | ')}`
  )
}

const browser = await chromium.launch({
  headless: false,
  args: ['--disable-dev-shm-usage']
})
const browserPid = findBrowserPid()

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
  const WorkerOrig = window.Worker
  window.Worker = class extends WorkerOrig {
    constructor(script, opts) {
      const key = 'worker ' + String(script).slice(0, 80)
      g.stacks[key] = (g.stacks[key] || 0) + 1
      super(script, opts)
    }
  }
  const fetchOrig = window.fetch.bind(window)
  window.fetch = (...args) => {
    g.stacks.fetch = (g.stacks.fetch || 0) + 1
    return fetchOrig(...args)
  }
  const qmt = window.queueMicrotask.bind(window)
  window.queueMicrotask = cb => {
    g.stacks.qmt = (g.stacks.qmt || 0) + 1
    return qmt(cb)
  }
  const MC = window.MessageChannel
  window.MessageChannel = class extends MC {
    constructor() {
      super()
      g.stacks.MessageChannel = (g.stacks.MessageChannel || 0) + 1
      for (const port of [this.port1, this.port2]) {
        const orig = port.postMessage.bind(port)
        port.postMessage = (...args) => {
          g.stacks.portPostMessage = (g.stacks.portPostMessage || 0) + 1
          return orig(...args)
        }
      }
    }
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

const paneToggle = name => page.locator('.viewbar .pane-toggle', { hasText: name })

const sampleIdle = async label => {
  await page.evaluate(() => {
    const g = window.__idleHooks
    if (!g) return
    g.raf = 0
    g.timeout = 0
    g.interval = 0
    g.ro = 0
    g.mo = 0
    g.stacks = {}
  })

  const groups = familyByType(browserPid)
  const watched = [...groups.renderer, ...groups.gpu]
  const t0 = Date.now()
  const before = snapshot(watched)
  const threadsBefore = readThreads(groups.renderer)
  await page.waitForTimeout(IDLE_MS)
  const wall = (Date.now() - t0) / 1000
  const after = snapshot(watched)
  const threadsAfter = readThreads(groups.renderer)
  const renderer = cpuPct(before, after, wall, groups.renderer)
  const gpu = cpuPct(before, after, wall, groups.gpu)
  const total = cpuPct(before, after, wall, watched)
  const threadHits = []
  for (const [id, a] of threadsAfter) {
    const b = threadsBefore.get(id)
    const dt = a.ticks - (b?.ticks || 0)
    const pct = (dt / (wall * CLK)) * 100
    if (pct >= 1) threadHits.push({ id, comm: a.comm, pct })
  }
  threadHits.sort((x, y) => y.pct - x.pct)
  const hooks = await page.evaluate(() =>
    window.__idleHooks ? { ...window.__idleHooks } : { raf: 0, timeout: 0, interval: 0, ro: 0, mo: 0, stacks: {} }
  )

  console.log(`\n== ${label} (${IDLE_MS}ms idle, OS /proc) ==`)
  console.log(
    `  CPU  renderer=${renderer.pct.toFixed(2)}%  gpu=${gpu.pct.toFixed(2)}%  tab=${total.pct.toFixed(2)}%  rss=${(renderer.rss / 1024 / 1024).toFixed(1)}MB  renderers=${groups.renderer.length}`
  )
  for (const pid of groups.renderer) {
    const one = cpuPct(before, after, wall, [pid])
    console.log(`    renderer pid=${pid}  ${one.pct.toFixed(2)}%  rss=${(one.rss / 1024 / 1024).toFixed(1)}MB`)
  }
  if (threadHits.length) {
    console.log('  threads ≥1%:')
    for (const t of threadHits.slice(0, 12)) {
      console.log(`    ${t.pct.toFixed(1).padStart(6)}%  ${t.comm}  ${t.id}`)
    }
  }
  console.log(
    `  hooks rAF=${hooks.raf} (${(hooks.raf / wall).toFixed(1)}/s)  timeouts=${hooks.timeout}  intervals=${hooks.interval}  RO=${hooks.ro} (${(hooks.ro / wall).toFixed(1)}/s)  MO=${hooks.mo}`
  )
  const stackTop = Object.entries(hooks.stacks || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
  if (stackTop.length) {
    for (const [s, n] of stackTop) console.log(`    ${String(n).padStart(4)}  ${s.slice(0, 220)}`)
  }

  try {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 })
    await cdp.send('Profiler.start')
    await page.waitForTimeout(1500)
    const { profile } = await cdp.send('Profiler.stop')
    await cdp.detach()
    const byId = new Map((profile.nodes || []).map(n => [n.id, n]))
    const hits = new Map()
    const walk = (node, depth, seen) => {
      if (!node || depth > 6 || seen.has(node.id)) return []
      seen.add(node.id)
      const call = node.callFrame || {}
      const url = String(call.url || '')
      if (url.startsWith('pptr:') || url.includes('__playwright')) return []
      const name = `${call.functionName || '(anonymous)'} @ ${url.split('/').pop()}:${call.lineNumber ?? -1}`
      const parent = node.parent ? byId.get(node.parent) : null
      return [name, ...walk(parent, depth + 1, seen)]
    }
    for (const id of profile.samples || []) {
      const node = byId.get(id)
      if (!node) continue
      const stack = walk(node, 0, new Set())
      if (!stack.length) continue
      const key = stack.slice(0, 3).join(' <- ')
      hits.set(key, (hits.get(key) || 0) + 1)
    }
    const top = [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    if (top.length) {
      console.log('  profiler (1.5s):')
      for (const [name, n] of top) console.log(`    ${String(n).padStart(4)}  ${name.slice(0, 240)}`)
    }
  } catch (e) {
    console.log('  profiler error:', e.message)
  }
  return { label, renderer: renderer.pct, gpu: gpu.pct, tab: total.pct, rafPerSec: hooks.raf / wall, roPerSec: hooks.ro / wall }
}

const results = []
let failed = false

await page.goto('about:blank')
await page.waitForTimeout(800)
results.push(await sampleIdle('about:blank'))

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.locator('.topbar .logo').waitFor({ timeout: 15000 })
await page.waitForTimeout(2000)
results.push(await sampleIdle('markdown welcome (all panes)'))

await paneToggle('Agent').click()
await paneToggle('Preview').click()
await page.waitForTimeout(500)
results.push(await sampleIdle('markdown (agent+preview hidden)'))

await paneToggle('Agent').click()
await paneToggle('Preview').click()
await page.waitForTimeout(400)

if (!process.env.SKIP_TYPST) {
await putFile(
  'idle.typ',
  '#set text(font: "Atkinson Hyperlegible")\n#set page(width: 10cm, height: 16cm)\n= Idle\n#lorem(80)\n#pagebreak()\n#lorem(80)\n'
)
await page.locator('[role="treeitem"]', { hasText: 'idle.typ' }).first().waitFor({ timeout: 10000 })
await page.locator('[role="treeitem"]', { hasText: 'idle.typ' }).first().click()
await page.waitForFunction(
  () => {
    const layer = document.querySelector('.panel-preview .pdf-layer:not(.is-hidden)')
    return !!(layer && layer.querySelector('canvas'))
  },
  { timeout: 20000 }
)
await page.waitForTimeout(1500)
results.push(await sampleIdle('typst preview idle (2 pages)'))
}

console.log('\n== summary (renderer CPU% of one core) ==')
for (const r of results) {
  console.log(`  ${r.renderer.toFixed(2).padStart(6)}%  ${r.label}`)
}

const hot = results.filter(r => r.label !== 'about:blank' && r.renderer > 3)
if (hot.length) {
  console.log('\nFAIL renderer CPU > 3% while idle:')
  for (const r of hot) console.log(`  ${r.label}: ${r.renderer.toFixed(2)}%`)
  failed = true
}

await browser.close()
process.exit(failed ? 1 : 0)
