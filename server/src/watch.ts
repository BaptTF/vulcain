import path from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import { findWorkspace, loadConfig, relativeToWorkspace } from './config.js'

interface WatchEntry {
  watcher: FSWatcher
  clients: Set<WebSocket>
}

const entries = new Map<string, WatchEntry>()

function keyFor(name: string): string {
  return name
}

export function broadcastFsEvent(workspace: string, event: string, absPath: string): void {
  void workspace
  void event
  void absPath
}

export function registerWatchApi(app: FastifyInstance): void {
  app.get('/api/watch', { websocket: true }, (sock, req) => {
    const q = req.query as { ws?: string }
    const cfg = loadConfig()
    const ws = findWorkspace(cfg, q.ws ?? '')
    if (!ws) {
      sock.close(4004, 'unknown workspace')
      return
    }
    const key = keyFor(ws.name)
    let entry = entries.get(key)
    if (!entry) {
      entry = { watcher: createWatcher(ws.name, ws.root), clients: new Set() }
      entries.set(key, entry)
    }
    entry.clients.add(sock)

    sock.on('close', () => {
      entry!.clients.delete(sock)
      if (entry!.clients.size === 0) {
        setTimeout(() => {
          const e = entries.get(key)
          if (e && e.clients.size === 0) {
            e.watcher.close().catch(() => {})
            entries.delete(key)
          }
        }, 30_000).unref()
      }
    })
  })
}

function createWatcher(name: string, root: string): FSWatcher {
  const w = watch(root, {
    ignoreInitial: true,
    depth: 14,
    ignored: (p: string) => {
      const parts = p.split(path.sep)
      return parts.includes('node_modules') || parts.includes('.git')
    }
  })
  const send = (event: string, p: string) => {
    const entry = entries.get(keyFor(name))
    if (!entry || entry.clients.size === 0) return
    const rel = relativeToWorkspace({ name, root }, p)
    if (!rel || rel.startsWith('..')) return
    const msg = JSON.stringify({ type: 'fs', event, path: rel })
    for (const c of entry.clients) {
      if (c.readyState === c.OPEN) c.send(msg)
    }
  }
  w.on('add', p => send('add', p))
  w.on('change', p => send('change', p))
  w.on('unlink', p => send('unlink', p))
  w.on('addDir', p => send('addDir', p))
  w.on('unlinkDir', p => send('unlinkDir', p))
  w.on('error', () => {})
  return w
}
