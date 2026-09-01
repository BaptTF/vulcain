import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface CamofoxConfig {
  baseUrl?: string
  accessKey?: string
}

export interface WebSearchConfig {
  provider?: string
  macro?: string
  baseUrl?: string
  engines?: string
  categories?: string
  maxResults?: number
  apiKey?: string
}

export interface WebReadConfig {
  method?: 'auto' | 'tavily' | 'camofox'
}

export interface ResearchConfig {
  depth?: 'quick' | 'deep'
  maxSources?: number
  cacheTtlMinutes?: number
  saveToNote?: boolean
}

export interface VulcainToolsConfig {
  camofox?: CamofoxConfig
  webSearch?: WebSearchConfig
  webRead?: WebReadConfig
  research?: ResearchConfig
}

export interface SearchParams {
  query: string
  category?: string
  timeRange?: string
  maxResults?: number
  engines?: string[]
}

export interface SearchResult {
  title: string
  url: string
  content: string
  score?: number
  engine?: string
}

export interface SearchResponse {
  results: SearchResult[]
  answer?: string
}

type FetchImpl = typeof fetch

export function loadVulcainConfig(): { tools?: VulcainToolsConfig } {
  const base = process.env.VULCAIN_HOME || path.join(os.homedir(), '.vulcain')
  try {
    return JSON.parse(fs.readFileSync(path.join(base, 'config', 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}

export function camofoxBase(): string {
  const c = loadVulcainConfig().tools?.camofox
  return (c?.baseUrl ?? process.env.VULCAIN_CAMOFOX_URL ?? 'http://127.0.0.1:9377').replace(/\/+$/, '')
}

async function camofox(method: string, urlPath: string, body?: unknown): Promise<any> {
  const accessKey = loadVulcainConfig().tools?.camofox?.accessKey
  const res = await fetch(`${camofoxBase()}${urlPath}`, {
    method,
    headers: {
      ...(accessKey ? { authorization: `Bearer ${accessKey}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`camofox ${method} ${urlPath} -> ${res.status}: ${text.slice(0, 500)}`)
  }
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) return res.json()
  return Buffer.from(await res.arrayBuffer())
}

async function snapshot(tabId: string, extraQuery = ''): Promise<string> {
  const data = await camofox('GET', `/tabs/${tabId}/snapshot?userId=vulcain${extraQuery}`)
  const snap = typeof data === 'string' ? data : (data.snapshot ?? JSON.stringify(data))
  return String(snap).slice(0, 12000)
}

async function closeTabQuietly(tabId: string): Promise<void> {
  try {
    await camofox('DELETE', `/tabs/${tabId}?userId=vulcain`)
  } catch {}
}

function isTabGone(err: unknown): boolean {
  return err instanceof Error && /-> 410:/.test(err.message)
}

function toResults(list: any[]): SearchResult[] {
  return (list ?? [])
    .map((r: any) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      content: r.content ?? '',
      score: typeof r.score === 'number' ? r.score : undefined,
      engine: r.engine
    }))
    .filter((r: SearchResult) => r.url)
}

export async function searxngSearch(baseUrl: string, engines: string | undefined, params: SearchParams, fetchImpl: FetchImpl): Promise<SearchResponse> {
  const u = new URL('/search', baseUrl)
  u.searchParams.set('q', params.query)
  u.searchParams.set('format', 'json')
  u.searchParams.set('safesearch', '1')
  if (params.category && params.category !== 'general') u.searchParams.set('categories', params.category)
  if (engines) u.searchParams.set('engines', engines)
  if (params.timeRange) u.searchParams.set('time_range', params.timeRange)
  const res = await fetchImpl(u.toString())
  if (!res.ok) throw new Error(`searxng ${u.pathname} -> ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await res.json()
  const results = toResults(data.results)
  return {
    results: params.maxResults ? results.slice(0, params.maxResults) : results,
    answer: Array.isArray(data.answers) && data.answers.length > 0 ? String(data.answers[0]) : undefined
  }
}

export async function tavilySearch(apiKey: string, params: SearchParams, fetchImpl: FetchImpl): Promise<SearchResponse> {
  const body: Record<string, unknown> = {
    query: params.query,
    max_results: params.maxResults ?? 6,
    search_depth: 'basic',
    include_answer: true
  }
  if (params.category && ['general', 'news', 'finance'].includes(params.category)) body.topic = params.category
  if (params.timeRange) body.time_range = params.timeRange
  const res = await fetchImpl('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`tavily search -> ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await res.json()
  const results = toResults(data.results)
  return {
    results: params.maxResults ? results.slice(0, params.maxResults) : results,
    answer: data.answer
  }
}

export async function camofoxSearch(config: WebSearchConfig, params: SearchParams): Promise<SearchResponse> {
  const macro = config.macro ?? '@google_search'
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let tabId = ''
    try {
      const tab = await camofox('POST', '/tabs', { userId: 'vulcain', sessionKey: 'vulcain-search' })
      tabId = tab.tabId
      await camofox('POST', `/tabs/${tabId}/navigate`, { userId: 'vulcain', macro, query: params.query })
      return { results: [], answer: await snapshot(tabId) }
    } catch (err) {
      if (attempt === 0 && isTabGone(err)) continue
      throw err
    } finally {
      if (tabId) void closeTabQuietly(tabId)
    }
  }
  throw new Error('unreachable')
}

export async function tavilyExtract(apiKey: string, url: string, fetchImpl: FetchImpl): Promise<string> {
  const res = await fetchImpl('https://api.tavily.com/extract', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ urls: [url], extract_depth: 'basic' })
  })
  if (!res.ok) throw new Error(`tavily extract -> ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await res.json()
  const hit = (data.results ?? []).find((r: any) => r.url === url) ?? (data.results ?? [])[0]
  return hit?.raw_content ?? ''
}

export async function readUrlViaCamofox(url: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let tab
    try {
      tab = await camofox('POST', '/tabs', { userId: 'vulcain', sessionKey: 'vulcain-read', url })
      return await snapshot(tab.tabId)
    } catch (err) {
      if (attempt === 0 && isTabGone(err)) continue
      throw err
    } finally {
      if (tab) void closeTabQuietly(tab.tabId)
    }
  }
  throw new Error('unreachable')
}

export async function readUrl(cfg: VulcainToolsConfig, url: string, fetchImpl: FetchImpl): Promise<string> {
  const method = cfg.webRead?.method ?? 'auto'
  const apiKey = cfg.webSearch?.apiKey || process.env.TAVILY_API_KEY || ''
  if (method !== 'camofox' && apiKey) {
    try {
      const text = await tavilyExtract(apiKey, url, fetchImpl)
      if (text) return text
    } catch {}
  }
  return readUrlViaCamofox(url)
}

export { camofox }