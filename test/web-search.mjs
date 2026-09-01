import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { searxngSearch, tavilySearch, readUrl } from '../pi-ext/src/providers.ts'
import { runResearch, runSearch } from '../pi-ext/src/research.ts'
import { buildBrief, dedupeByUrl } from '../pi-ext/src/format.ts'
import { RateLimiter, TtlCache } from '../pi-ext/src/cache.ts'

const results = []
function check(name, cond) {
  results.push([name, cond])
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`)
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, async text() { return JSON.stringify(body) }, async json() { return body } }
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vulcain-search-'))
process.env.VULCAIN_HOME = HOME
fs.mkdirSync(path.join(HOME, 'config'), { recursive: true })
fs.writeFileSync(path.join(HOME, 'config', 'config.json'), JSON.stringify({
  tools: { camofox: { baseUrl: 'http://camofox.test' } }
}))

const searxngCfg = {
  webSearch: { provider: 'searxng', baseUrl: 'http://searxng.test', engines: 'bing,duckduckgo', maxResults: 6 },
  webRead: { method: 'auto' }
}

async function main() {
  let hits = []
  const fakeSearch = async url => {
    const u = new URL(url)
    hits.push(u.toString())
    if (u.hostname === 'searxng.test') {
      const q = u.searchParams.get('q')
      return jsonResponse({
        query: q,
        results: [
          { title: `${q} A`, url: 'http://a.example', content: `about ${q}`, score: 0.9, engine: 'bing' },
          { title: `${q} B`, url: 'http://b.example', content: `more ${q}`, score: 0.7, engine: 'duckduckgo' }
        ],
        answers: []
      })
    }
    throw new Error(`unexpected fetch ${url}`)
  }

  const s1 = await searxngSearch('http://searxng.test', 'bing,duckduckgo', { query: 'vulcain', category: 'news', maxResults: 2 }, fakeSearch)
  check('searxng: parses results', s1.results.length === 2 && s1.results[0].title === 'vulcain A' && s1.results[0].url === 'http://a.example')
  check('searxng: slices maxResults', s1.results.length === 2)
  const lastHit = hits[hits.length - 1]
  check('searxng: sends format=json', /[?&]format=json/.test(lastHit))
  check('searxng: sends engines + categories', /engines=bing%2Cduckduckgo/.test(lastHit) && /categories=news/.test(lastHit))

  let tavilyBody = null
  let tavilyAuth = ''
  const fakeTavily = async (url, init) => {
    tavilyBody = JSON.parse(init.body)
    tavilyAuth = init.headers.authorization
    return jsonResponse({
      query: 'test',
      results: [{ title: 'T', url: 'http://t.example', content: 'tc', score: 0.5 }],
      answer: 'short answer'
    })
  }
  const t1 = await tavilySearch('tvly-123', { query: 'test', category: 'news', timeRange: 'week', maxResults: 3 }, fakeTavily)
  check('tavily: bearer auth + parsed results/answer', tavilyAuth === 'Bearer tvly-123' && t1.results[0].title === 'T' && t1.answer === 'short answer')
  check('tavily: sends topic/time_range/max_results', tavilyBody.topic === 'news' && tavilyBody.time_range === 'week' && tavilyBody.max_results === 3)

  const cache = new TtlCache(60_000)
  hits = []
  const r1 = await runSearch({ ...searxngCfg }, { query: 'cached' }, { fetch: fakeSearch, cache })
  const r2 = await runSearch({ ...searxngCfg }, { query: 'cached' }, { fetch: fakeSearch, cache })
  check('cache: second call served from cache', hits.length === 1 && r1.results.length === r2.results.length)

  // --- defaults when config omits them ---
  const noMaxCfg = { webSearch: { provider: 'searxng', baseUrl: 'http://searxng.test', engines: 'bing' } }
  const fakeMany = async url => {
    const u = new URL(url)
    const q = u.searchParams.get('q')
    return jsonResponse({
      query: q,
      results: Array.from({ length: 12 }, (_, i) => ({ title: `${q} ${i}`, url: `http://r${i}.example`, content: q, score: 1 - i / 20 })),
      answers: []
    })
  }
  const d = await runSearch(noMaxCfg, { query: 'defaults' }, { fetch: fakeMany, cache: new TtlCache(60_000), rate: new RateLimiter(0) })
  check('defaults: maxResults is 10 when unset', d.results.length === 10)

  // --- time_range passthrough ---
  hits = []
  await runSearch({ ...searxngCfg }, { query: 'actu', timeRange: 'week' }, { fetch: fakeSearch, cache: new TtlCache(60_000), rate: new RateLimiter(0) })
  check('searxng: sends time_range', /[?&]time_range=week/.test(hits[hits.length - 1]))

  // --- engines: subset, intersection and cache key ---
  hits = []
  const engCache = new TtlCache(60_000)
  await runSearch({ ...searxngCfg }, { query: 'eng', engines: ['duckduckgo'] }, { fetch: fakeSearch, cache: engCache, rate: new RateLimiter(0) })
  check('engines: subset is sent', /engines=duckduckgo$/.test(hits[hits.length - 1]))
  await runSearch({ ...searxngCfg }, { query: 'eng', engines: ['wikipedia'] }, { fetch: fakeSearch, cache: engCache, rate: new RateLimiter(0) })
  check('engines: unknown engine falls back to allowlist', /engines=bing%2Cduckduckgo/.test(hits[hits.length - 1]))
  const e3 = await runSearch({ ...searxngCfg }, { query: 'eng', engines: ['wikipedia'] }, { fetch: fakeSearch, cache: engCache, rate: new RateLimiter(0) })
  check('cache: engine variation creates distinct cache keys', hits.length === 2 && e3.results.length > 0)

  // --- engines: empty results with explicit subset -> retry with default engines ---
  hits = []
  const fakeEmptySubset = async url => {
    const u = new URL(url)
    hits.push(u.toString())
    const q = u.searchParams.get('q')
    const engines = u.searchParams.get('engines')
    if (engines === 'duckduckgo') return jsonResponse({ query: q, results: [], answers: [] })
    return jsonResponse({ query: q, results: [{ title: q, url: 'http://ok.example', content: q, score: 1, engine: 'bing' }], answers: [] })
  }
  const er = await runSearch({ ...searxngCfg }, { query: 'retry', engines: ['duckduckgo'] }, { fetch: fakeEmptySubset, cache: new TtlCache(60_000), rate: new RateLimiter(0) })
  check('engines: empty subset retried with default engines', hits.length === 2 && er.results.length === 1 && /engines=duckduckgo/.test(hits[0]))

  globalThis.fetch = async (url, init) => {
    const u = new URL(url)
    if (u.hostname === 'searxng.test') throw new Error('searxng unreachable')
    if (u.hostname === 'camofox.test') {
      if (u.pathname === '/tabs' && init?.method === 'POST') return jsonResponse({ tabId: 't1' })
      if (/\/tabs\/t1\/navigate/.test(u.pathname)) return jsonResponse({})
      if (/\/tabs\/t1\/snapshot/.test(u.pathname)) return jsonResponse({ snapshot: 'CAMOFOX_SNAPSHOT' })
      if (u.pathname.startsWith('/tabs/t1') && init?.method === 'DELETE') return jsonResponse({})
    }
    throw new Error(`unexpected global fetch ${url}`)
  }
  const fb = await runSearch({ ...searxngCfg }, { query: 'down' }, { fetch: async () => { throw new Error('searxng unreachable') } })
  check('fallback: searxng down -> camofox snapshot', fb.results.length === 0 && fb.answer === 'CAMOFOX_SNAPSHOT')

  // --- camofox: retry once on 410 "tab no longer exists" ---
  let camofoxTabs = 0
  const camofox410 = (snapshotStatus) => async (url, init) => {
    const u = new URL(url)
    if (u.hostname !== 'camofox.test') throw new Error(`unexpected ${url}`)
    if (u.pathname === '/tabs' && init?.method === 'POST') {
      camofoxTabs += 1
      return jsonResponse({ tabId: `t${camofoxTabs}` })
    }
    if (/\/navigate/.test(u.pathname)) return jsonResponse({})
    if (/\/snapshot/.test(u.pathname)) {
      if (snapshotStatus(camofoxTabs)) {
        return { ok: false, status: 410, headers: { get: () => 'text/plain' }, async text() { return '{"error":"Tab no longer exists (browser was restarted)."}' }, async json() { return {} } }
      }
      return jsonResponse({ snapshot: `OK_${camofoxTabs}` })
    }
    if (init?.method === 'DELETE') return jsonResponse({})
    throw new Error(`unexpected ${url}`)
  }
  globalThis.fetch = camofox410(tab => tab === 1)
  const r410 = await runSearch({ webSearch: { provider: 'camofox-macro', macro: '@google_search' } }, { query: 'x' }, { rate: new RateLimiter(0) })
  check('camofox: search retries once on 410 tab-gone', camofoxTabs === 2 && r410.answer === 'OK_2')

  globalThis.fetch = camofox410(tab => tab === 3)
  const read410 = await readUrl({ webRead: { method: 'camofox' }, webSearch: {} }, 'http://page.example')
  check('readUrl: camofox retries once on 410 tab-gone', camofoxTabs === 4 && read410 === 'OK_4')

  const fakeMulti = async url => {
    const u = new URL(url)
    const q = u.searchParams.get('q')
    return jsonResponse({
      query: q,
      results: [
        { title: `${q} R1`, url: 'http://shared.example', content: q, score: 0.9 },
        { title: `${q} R2`, url: `http://${q}.example`, content: q, score: 0.5 }
      ]
    })
  }
  const res = await runResearch(
    { ...searxngCfg },
    { topic: 't', subQueries: ['s1', 's2'], depth: 'quick', maxSources: 4 },
    { fetch: fakeMulti, cache: new TtlCache(60_000), rate: new RateLimiter(0) }
  )
  check('research: parallel sub-queries merged', res.sources.length >= 1)
  check('research: dedupes by url', dedupeByUrl(res.brief.split('\n').filter(l => /example/.test(l))).length >= 0)
  check('research: brief cites sources [n]', /\[1\]/.test(res.brief))
  const sharedCount = (res.brief.match(/shared\.example/g) ?? []).length
  check('research: shared url appears once in sources list', res.brief.includes('1. [') && sharedCount <= 2)

  const deepFetch = async (url, init) => {
    const u = new URL(url)
    if (u.hostname === 'searxng.test') return fakeMulti(url)
    if (u.hostname === 'api.tavily.com') {
      const body = JSON.parse(init.body)
      return jsonResponse({ results: [{ url: body.urls[0], raw_content: 'DEEP_CONTENT' }] })
    }
    throw new Error(`unexpected ${url}`)
  }
  const deepCfg = { ...searxngCfg, webSearch: { ...searxngCfg.webSearch, apiKey: 'tvly-123' } }
  const deep = await runResearch(
    deepCfg,
    { topic: 'deep', depth: 'deep', maxSources: 2 },
    { fetch: deepFetch, cache: new TtlCache(60_000), rate: new RateLimiter(0) }
  )
  check('research: deep extracts source content', deep.brief.includes('[extrait] DEEP_CONTENT'))

  const read = await readUrl(deepCfg, 'http://page.example', deepFetch)
  check('readUrl: uses tavily extract when key present', read === 'DEEP_CONTENT')

  const noteCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vulcain-note-'))
  const prevCwd = process.cwd()
  process.chdir(noteCwd)
  const noted = await runResearch(
    { ...searxngCfg },
    { topic: 'My Big Topic!', saveToNote: true },
    { fetch: fakeMulti, cache: new TtlCache(60_000), rate: new RateLimiter(0) }
  )
  process.chdir(prevCwd)
  const notePath = path.join(noteCwd, '.research', 'my-big-topic.md')
  check('research: saveToNote writes .research/my-big-topic.md', fs.existsSync(notePath) && fs.readFileSync(notePath, 'utf8').includes('My Big Topic'))

  const brief = buildBrief('x', 'ans', [{ title: 't', url: 'http://u.example', content: 'c' }], [{ title: 't', url: 'http://u.example', content: 'c' }])
  check('format: brief header + answer + [1] citation', brief.includes('## Recherche : x') && brief.includes('Réponse courte') && brief.includes('[1] **t**'))

  const ttl = new TtlCache(30)
  ttl.set('k', 1)
  check('cache: value present before TTL', ttl.get('k') === 1)
  await new Promise(r => setTimeout(r, 40))
  check('cache: expired after TTL', ttl.get('k') === undefined)

  const rate = new RateLimiter(60)
  const t0 = Date.now()
  await rate.wait()
  await rate.wait()
  check('rate: enforces min interval', Date.now() - t0 >= 50)

  const failed = results.filter(([, ok]) => !ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})