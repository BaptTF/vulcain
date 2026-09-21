import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

export interface WorkspaceDef {
  name: string
  path: string
}

export interface VulcainConfig {
  theme: 'dark' | 'light'
  server: { host: string; port: number }
  workspaces: WorkspaceDef[]
  configWorkspace: string
  llm?: { provider?: Record<string, unknown> }
  agent: { systemPrompt?: string }
  tools: {
    camofox?: { baseUrl: string; accessKey?: string }
    webSearch?: {
      provider?: string
      macro?: string
      baseUrl?: string
      engines?: string
      categories?: string
      maxResults?: number
      apiKey?: string
    }
    webRead?: { method?: 'auto' | 'tavily' | 'camofox' }
    research?: { depth?: 'quick' | 'deep'; maxSources?: number; cacheTtlMinutes?: number; saveToNote?: boolean }
  }
}

export function vulcainHome(): string {
  return process.env.VULCAIN_HOME || path.join(os.homedir(), '.vulcain')
}

export function configPath(): string {
  return path.join(vulcainHome(), 'config', 'config.json')
}

export function lastGoodConfigPath(): string {
  return path.join(vulcainHome(), 'config.json.last-good')
}

const DEFAULTS: VulcainConfig = {
  theme: 'dark',
  server: { host: '127.0.0.1', port: 7331 },
  workspaces: [],
  configWorkspace: path.join(vulcainHome(), 'config'),
  agent: {},
  tools: {}
}

interface CachedGood {
  cfg: VulcainConfig
  text: string
}

let cachedGood: CachedGood | undefined
let persistedLastGoodText: string | undefined
let invalidWarned = false

function defaultSystemPromptPath(configWorkspace: string): string {
  return path.join(expandHome(configWorkspace), 'SYSTEM.md')
}

function writeAtomic(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, contents)
    fs.renameSync(tmp, file)
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {}
    throw err
  }
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const raw = JSON.parse(text) as unknown
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      return raw as Record<string, unknown>
    }
  } catch {}
  return undefined
}

function asWorkspaces(value: unknown): WorkspaceDef[] {
  if (!Array.isArray(value)) return DEFAULTS.workspaces
  return value.filter(
    (w): w is WorkspaceDef =>
      Boolean(w) && typeof w === 'object' && typeof (w as WorkspaceDef).name === 'string' && typeof (w as WorkspaceDef).path === 'string'
  )
}

function normalize(raw: Record<string, unknown>): VulcainConfig {
  const configWorkspace = typeof raw.configWorkspace === 'string' ? raw.configWorkspace : DEFAULTS.configWorkspace
  const agentRaw = raw.agent && typeof raw.agent === 'object' && !Array.isArray(raw.agent) ? (raw.agent as Record<string, unknown>) : {}
  const agent = { ...DEFAULTS.agent, ...agentRaw }
  if (agent.systemPrompt === undefined) {
    agent.systemPrompt = defaultSystemPromptPath(configWorkspace)
  }
  const serverRaw = raw.server && typeof raw.server === 'object' && !Array.isArray(raw.server) ? raw.server : {}
  return {
    ...DEFAULTS,
    ...raw,
    workspaces: asWorkspaces(raw.workspaces),
    configWorkspace,
    agent,
    server: { ...DEFAULTS.server, ...serverRaw }
  } as VulcainConfig
}

function rememberGood(cfg: VulcainConfig, text: string): void {
  cachedGood = { cfg, text }
  invalidWarned = false
  if (persistedLastGoodText === text) return
  try {
    writeAtomic(lastGoodConfigPath(), text)
    persistedLastGoodText = text
  } catch (err) {
    console.warn('[vulcain] could not persist last-good config:', err)
  }
}

function warnOnce(message: string): void {
  if (invalidWarned) return
  invalidWarned = true
  console.warn(`[vulcain] ${message}`)
}

function fallback(reason: 'invalid' | 'missing'): VulcainConfig {
  if (cachedGood) {
    if (reason === 'invalid') warnOnce('config.json is invalid, using last good config')
    return cachedGood.cfg
  }
  const backupText = readText(lastGoodConfigPath())
  const backup = backupText !== undefined ? parseObject(backupText) : undefined
  if (backup && backupText !== undefined) {
    warnOnce(reason === 'invalid' ? 'config.json is invalid, using last good config' : 'config.json missing, using last good config')
    const cfg = normalize(backup)
    cachedGood = { cfg, text: backupText }
    persistedLastGoodText = backupText
    return cfg
  }
  if (reason === 'invalid') warnOnce('config.json is invalid, using defaults')
  return normalize({})
}

/** Clear in-memory last-good cache. Used by tests to simulate a process restart. */
export function resetConfigCache(): void {
  cachedGood = undefined
  persistedLastGoodText = undefined
  invalidWarned = false
}

export function loadConfig(): VulcainConfig {
  const text = readText(configPath())
  if (text !== undefined) {
    if (cachedGood && cachedGood.text === text) return cachedGood.cfg
    const raw = parseObject(text)
    if (raw) {
      const cfg = normalize(raw)
      rememberGood(cfg, text)
      return cfg
    }
    return fallback('invalid')
  }
  return fallback('missing')
}

export function saveConfig(cfg: VulcainConfig): void {
  const text = JSON.stringify(cfg, null, 2) + '\n'
  writeAtomic(configPath(), text)
  rememberGood(cfg, text)
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

export function tildePath(p: string): string {
  const home = os.homedir()
  if (p === home) return '~'
  if (p.startsWith(home + path.sep)) return '~' + p.slice(home.length)
  return p
}

export interface ResolvedWorkspace {
  name: string
  root: string
}

export function allWorkspaces(cfg: VulcainConfig): ResolvedWorkspace[] {
  const list = cfg.workspaces.map(w => ({ name: w.name, root: expandHome(w.path) }))
  list.push({ name: '__config__', root: expandHome(cfg.configWorkspace) })
  return list
}

export function findWorkspace(cfg: VulcainConfig, name: string): ResolvedWorkspace | undefined {
  return allWorkspaces(cfg).find(w => w.name === name)
}

export function resolveInWorkspace(ws: ResolvedWorkspace, rel: string): string {
  const root = path.resolve(ws.root)
  const abs = path.resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('path escapes workspace')
  }
  return abs
}

export function relativeToWorkspace(ws: ResolvedWorkspace, abs: string): string {
  return path.relative(path.resolve(ws.root), abs).split(path.sep).join('/')
}
