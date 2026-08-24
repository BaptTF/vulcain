import fs from 'node:fs'
import os from 'node:os'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import {
  allWorkspaces,
  expandHome,
  findWorkspace,
  loadConfig,
  resolveInWorkspace,
  saveConfig,
  vulcainHome
} from './config.js'

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif',
  'pdf', 'zip', 'gz', 'tar', '7z', 'woff', 'woff2', 'ttf', 'otf',
  'mp3', 'mp4', 'wav', 'ogg', 'mov', 'webm'
])

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'target'])

function workspace(name: string | undefined) {
  const cfg = loadConfig()
  const ws = findWorkspace(cfg, name ?? '')
  if (!ws) throw new Error(`unknown workspace: ${name}`)
  return ws
}

function browseRoot(): string {
  const raw = process.env.VULCAIN_WORKSPACES || path.join(vulcainHome(), 'workspaces')
  return path.resolve(expandHome(raw))
}

function resolveBrowse(rel: string): { root: string; abs: string } {
  const root = browseRoot()
  const abs = path.resolve(root, rel ?? '')
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('path escapes browse root')
  }
  return { root, abs }
}

async function listDirs(abs: string): Promise<{ name: string; type: 'dir' }[]> {
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(abs, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(e => e.isDirectory() && e.name !== '.' && e.name !== '..')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(e => ({ name: e.name, type: 'dir' as const }))
}

interface TreeEntry {
  name: string
  path: string
  type: 'file' | 'dir'
}

async function walk(dir: string, rel: string, out: TreeEntry[], depth: number): Promise<void> {
  if (depth > 12) return
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.agents' && e.name !== '.pi') continue
    if (SKIP_DIRS.has(e.name)) continue
    const childRel = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      out.push({ name: e.name, path: childRel, type: 'dir' })
      await walk(path.join(dir, e.name), childRel, out, depth + 1)
    } else if (e.isFile()) {
      out.push({ name: e.name, path: childRel, type: 'file' })
    }
  }
}

export function registerFsApi(app: FastifyInstance): void {
  app.get('/api/meta', async () => {
    const cfg = loadConfig()
    return {
      theme: cfg.theme,
      workspaces: allWorkspaces(cfg).map(w => ({ name: w.name })),
      defaultWorkspace: cfg.workspaces[0]?.name ?? '__config__'
    }
  })

  app.post('/api/meta/theme', async (req) => {
    const { theme } = req.body as { theme?: string }
    if (theme !== 'dark' && theme !== 'light') throw new Error('invalid theme')
    const cfg = loadConfig()
    cfg.theme = theme
    saveConfig(cfg)
    return { ok: true, theme }
  })

  app.get('/api/fs/tree', async (req) => {
    const q = req.query as { ws?: string }
    const ws = workspace(q.ws)
    const out: TreeEntry[] = []
    await walk(ws.root, '', out, 0)
    return { root: ws.name, entries: out }
  })

  app.get('/api/fs/file', async (req, reply) => {
    const q = req.query as { ws?: string; path?: string }
    const ws = workspace(q.ws)
    const abs = resolveInWorkspace(ws, q.path ?? '')
    const st = await fsp.stat(abs)
    if (!st.isFile()) throw new Error('not a file')
    const ext = path.extname(abs).slice(1).toLowerCase()
    if (BINARY_EXT.has(ext)) {
      const data = await fsp.readFile(abs)
      reply.header('content-type', mimeOf(ext))
      return reply.send(data)
    }
    return { content: await fsp.readFile(abs, 'utf8') }
  })

  app.get('/api/fs/download', async (req, reply) => {
    const q = req.query as { ws?: string; path?: string }
    const ws = workspace(q.ws)
    const abs = resolveInWorkspace(ws, q.path ?? '')
    const st = await fsp.stat(abs)
    if (!st.isFile()) throw new Error('not a file')
    const name = path.basename(abs)
    const ext = path.extname(abs).slice(1).toLowerCase()
    reply.header('content-type', mimeOf(ext))
    reply.header('content-length', st.size)
    const asciiName = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
    reply.header(
      'content-disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`
    )
    return reply.send(await fsp.readFile(abs))
  })

  app.get('/api/fs/browse', async (req) => {
    const q = req.query as { path?: string }
    const { root, abs } = resolveBrowse(q.path ?? '')
    await fsp.mkdir(root, { recursive: true })
    const entries = await listDirs(abs)
    return {
      root,
      path: path.relative(root, abs).split(path.sep).join('/'),
      entries
    }
  })

  app.post('/api/workspaces', async (req) => {
    const body = req.body as { name?: string; path?: string }
    const name = (body.name ?? '').trim()
    const rel = body.path ?? ''
    if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error('nom de workspace invalide')
    const { root, abs } = resolveBrowse(rel)
    const st = await fsp.stat(abs).catch(() => null)
    if (!st?.isDirectory()) throw new Error('dossier introuvable')
    const cfg = loadConfig()
    if (cfg.workspaces.some(w => w.name === name)) throw new Error(`workspace déjà existant : ${name}`)
    cfg.workspaces.push({ name, path: abs === root ? root.replace(os.homedir(), '~') : abs.replace(os.homedir(), '~') })
    saveConfig(cfg)
    return { ok: true, name }
  })

  app.delete('/api/workspaces/:name', async (req) => {
    const { name } = req.params as { name: string }
    const cfg = loadConfig()
    const before = cfg.workspaces.length
    cfg.workspaces = cfg.workspaces.filter(w => w.name !== name)
    if (cfg.workspaces.length === before) throw new Error(`workspace inconnu : ${name}`)
    saveConfig(cfg)
    return { ok: true }
  })

  app.put('/api/fs/file', async (req) => {
    const body = req.body as { ws?: string; path?: string; content?: string; contentBase64?: string }
    const ws = workspace(body.ws)
    const abs = resolveInWorkspace(ws, body.path ?? '')
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    if (body.contentBase64 !== undefined) {
      await fsp.writeFile(abs, Buffer.from(body.contentBase64, 'base64'))
    } else {
      await fsp.writeFile(abs, body.content ?? '', 'utf8')
    }
    return { ok: true }
  })

  app.post('/api/fs/mkdir', async (req) => {
    const body = req.body as { ws?: string; path?: string }
    const ws = workspace(body.ws)
    await fsp.mkdir(resolveInWorkspace(ws, body.path ?? ''), { recursive: true })
    return { ok: true }
  })

  app.post('/api/fs/touch', async (req) => {
    const body = req.body as { ws?: string; path?: string }
    const ws = workspace(body.ws)
    const abs = resolveInWorkspace(ws, body.path ?? '')
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    if (!fs.existsSync(abs)) await fsp.writeFile(abs, '', 'utf8')
    return { ok: true }
  })

  app.post('/api/fs/rename', async (req) => {
    const body = req.body as { ws?: string; from?: string; to?: string }
    const ws = workspace(body.ws)
    const from = resolveInWorkspace(ws, body.from ?? '')
    const to = resolveInWorkspace(ws, body.to ?? '')
    await fsp.mkdir(path.dirname(to), { recursive: true })
    await fsp.rename(from, to)
    return { ok: true }
  })

  app.delete('/api/fs/delete', async (req) => {
    const body = req.body as { ws?: string; path?: string }
    const ws = workspace(body.ws)
    await fsp.rm(resolveInWorkspace(ws, body.path ?? ''), { recursive: true })
    return { ok: true }
  })
}

function mimeOf(ext: string): string {
  const m: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    woff2: 'font/woff2',
    ttf: 'font/ttf'
  }
  return m[ext] ?? 'application/octet-stream'
}
