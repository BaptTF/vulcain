import fs from 'node:fs'
import path from 'node:path'
import type { SearchParams, SearchResponse, SearchResult, WebSearchConfig, VulcainToolsConfig } from './providers.ts'
import { camofoxSearch, readUrl, searxngSearch, tavilySearch } from './providers.ts'
import { buildBrief, dedupeByUrl, rankByScore, slugify } from './format.ts'
import { RateLimiter, TtlCache } from './cache.ts'

type FetchImpl = typeof fetch

export interface ResearchOptions {
  topic: string
  subQueries?: string[]
  depth?: 'quick' | 'deep'
  maxSources?: number
  category?: string
  timeRange?: string
  engines?: string[]
  saveToNote?: boolean
}

export interface ResearchDeps {
  fetch?: FetchImpl
  cache?: TtlCache<SearchResponse>
  rate?: RateLimiter
}

function activeProvider(cfg: VulcainToolsConfig): { kind: 'searxng' | 'tavily' | 'camofox'; config: WebSearchConfig } {
  const ws = cfg.webSearch ?? {}
  const provider = ws.provider ?? 'camofox-macro'
  if (provider === 'tavily') {
    if (ws.apiKey || process.env.TAVILY_API_KEY) return { kind: 'tavily', config: ws }
    return { kind: 'camofox', config: ws }
  }
  if (provider === 'searxng') {
    if (ws.baseUrl || process.env.VULCAIN_SEARXNG_URL) return { kind: 'searxng', config: ws }
    return { kind: 'camofox', config: ws }
  }
  return { kind: 'camofox', config: ws }
}

let defaultCache: TtlCache<SearchResponse> | null = null
let defaultRate: RateLimiter | null = null

function getCache(cfg: VulcainToolsConfig, injected?: TtlCache<SearchResponse>): TtlCache<SearchResponse> {
  if (injected) return injected
  if (!defaultCache) {
    const ttl = (cfg.research?.cacheTtlMinutes ?? 30) * 60_000
    defaultCache = new TtlCache<SearchResponse>(ttl)
  }
  return defaultCache
}

function getRate(injected?: RateLimiter): RateLimiter {
  if (injected) return injected
  if (!defaultRate) defaultRate = new RateLimiter(300)
  return defaultRate
}

function configEngines(config: WebSearchConfig): string | undefined {
  return config.engines || undefined
}

/**
 * Resolve the effective SearXNG engines for a request: intersect the agent's
 * requested engines with the configured allowlist (single source of truth).
 * Falls back to the full allowlist when nothing requested, or when the
 * intersection is empty.
 */
function resolveEngines(config: WebSearchConfig, requested?: string[]): string | undefined {
  const base = configEngines(config)?.split(',').map(s => s.trim()).filter(Boolean) ?? []
  if (base.length === 0) return undefined
  if (!requested || requested.length === 0) return base.join(',')
  const allowed = base.filter(e => requested.includes(e))
  return (allowed.length > 0 ? allowed : base).join(',')
}

async function searchOnce(kind: 'searxng' | 'tavily' | 'camofox', config: WebSearchConfig, engines: string | undefined, params: SearchParams, fetchImpl: FetchImpl): Promise<SearchResponse> {
  if (kind === 'searxng') return searxngSearch(config.baseUrl ?? process.env.VULCAIN_SEARXNG_URL!, engines, params, fetchImpl)
  if (kind === 'tavily') return tavilySearch(config.apiKey ?? process.env.TAVILY_API_KEY!, params, fetchImpl)
  return camofoxSearch(config, params)
}

export async function runSearch(cfg: VulcainToolsConfig, params: SearchParams, deps: ResearchDeps = {}): Promise<SearchResponse> {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const { kind, config } = activeProvider(cfg)
  const engines = resolveEngines(config, params.engines)
  const effective = { ...params, maxResults: params.maxResults ?? cfg.webSearch?.maxResults ?? 10 }
  const key = `search|${kind}|${effective.query}|${effective.category ?? ''}|${effective.timeRange ?? ''}|${effective.maxResults}|${engines ?? ''}`
  const cache = getCache(cfg, deps.cache)
  const cached = cache.get(key)
  if (cached) return cached
  const rate = getRate(deps.rate)
  const defaultEngines = configEngines(config)
  const explicitSubset = kind === 'searxng' && engines !== defaultEngines
  try {
    await rate.wait()
    let resp = await searchOnce(kind, config, engines, effective, fetchImpl)
    if (explicitSubset && resp.results.length === 0) {
      resp = await searchOnce(kind, config, defaultEngines, effective, fetchImpl)
    }
    cache.set(key, resp)
    return resp
  } catch (err) {
    if (explicitSubset) {
      try {
        const resp = await searchOnce(kind, config, defaultEngines, effective, fetchImpl)
        cache.set(key, resp)
        return resp
      } catch {}
    }
    if (kind !== 'camofox') {
      const resp = await camofoxSearch(config, effective)
      cache.set(key, resp)
      return resp
    }
    throw err
  }
}

export interface ResearchOutcome {
  brief: string
  sources: SearchResult[]
  note?: string
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = i++
      if (idx >= items.length) return
      out[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return out
}

export async function runResearch(cfg: VulcainToolsConfig, opts: ResearchOptions, deps: ResearchDeps = {}): Promise<ResearchOutcome> {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const queries = Array.from(new Set([opts.topic, ...(opts.subQueries ?? [])]))
  const all: SearchResult[] = []
  let answer: string | undefined
  const maxResults = cfg.webSearch?.maxResults ?? 10

  const responses = await mapLimit(queries, 5, q =>
    runSearch(cfg, { query: q, category: opts.category, timeRange: opts.timeRange, maxResults, engines: opts.engines }, deps)
  )
  responses.forEach((resp, i) => {
    all.push(...resp.results)
    if (i === 0 && resp.answer) answer = resp.answer
  })

  const ranked0 = rankByScore(dedupeByUrl(all))
  const maxSources = opts.maxSources ?? cfg.research?.maxSources ?? 6
  let sources = ranked0.slice(0, maxSources)
  let ranked = ranked0

  if (opts.depth === 'deep') {
    sources = await mapLimit(sources, 3, async s => {
      try {
        const text = await readUrl(cfg, s.url, fetchImpl)
        return text ? { ...s, content: `[extrait] ${text.slice(0, 6000)}` } : s
      } catch {
        return s
      }
    })
    const byUrl = new Map(sources.map(s => [s.url, s]))
    ranked = ranked.map(r => {
      const ext = byUrl.get(r.url)
      return ext && ext.content ? { ...r, content: ext.content } : r
    })
  }

  const brief = buildBrief(opts.topic, answer, ranked, sources)
  let note: string | undefined
  if (opts.saveToNote ?? cfg.research?.saveToNote) {
    const dir = path.join(process.cwd(), '.research')
    fs.mkdirSync(dir, { recursive: true })
    note = path.join(dir, `${slugify(opts.topic)}.md`)
    fs.writeFileSync(note, `# ${opts.topic}\n\n> ${new Date().toISOString()}\n\n${brief}\n`)
  }
  return { brief, sources, note }
}