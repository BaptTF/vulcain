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
  agent: { command: string[]; args?: string[] }
  tools: {
    camofox?: { baseUrl: string; accessKey?: string }
    webSearch?: { provider?: string; macro?: string }
  }
}

export function vulcainHome(): string {
  return process.env.VULCAIN_HOME || path.join(os.homedir(), '.vulcain')
}

export function configPath(): string {
  return path.join(vulcainHome(), 'config', 'config.json')
}

const DEFAULTS: VulcainConfig = {
  theme: 'dark',
  server: { host: '127.0.0.1', port: 7331 },
  workspaces: [],
  configWorkspace: path.join(vulcainHome(), 'config'),
  agent: { command: ['pi-acp'], args: [] },
  tools: {}
}

export function loadConfig(): VulcainConfig {
  const p = configPath()
  let raw: any = {}
  if (fs.existsSync(p)) {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'))
  }
  return { ...DEFAULTS, ...raw, server: { ...DEFAULTS.server, ...(raw.server ?? {}) } }
}

export function saveConfig(cfg: VulcainConfig): void {
  const p = configPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n')
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
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
