export interface Meta {
  theme: 'dark' | 'light'
  workspaces: { name: string; root?: string }[]
  defaultWorkspace: string
}

export interface TreeEntry {
  name: string
  path: string
  type: 'file' | 'dir'
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...init
  })
  if (!res.ok) {
    let msg = `${res.status}`
    try {
      const body = await res.json()
      if (body?.error) msg = body.error
    } catch {}
    throw new Error(msg)
  }
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) return res.json() as Promise<T>
  return undefined as T
}

export function getMeta(): Promise<Meta> {
  return req('/api/meta')
}

export function setTheme(theme: 'dark' | 'light'): Promise<void> {
  return req('/api/meta/theme', { method: 'POST', body: JSON.stringify({ theme }) })
}

export function getTree(ws: string): Promise<{ entries: TreeEntry[] }> {
  return req(`/api/fs/tree?ws=${encodeURIComponent(ws)}`)
}

export function fileUrl(ws: string, path: string): string {
  return `/api/fs/file?ws=${encodeURIComponent(ws)}&path=${encodeURIComponent(path)}`
}

export function downloadUrl(ws: string, path: string): string {
  return `/api/fs/download?ws=${encodeURIComponent(ws)}&path=${encodeURIComponent(path)}`
}

export async function readFile(ws: string, path: string): Promise<string> {
  const r = await fetch(fileUrl(ws, path))
  if (!r.ok) throw new Error(`read failed ${r.status}`)
  const ct = r.headers.get('content-type') ?? ''
  if (ct.startsWith('application/json')) {
    const body = await r.json()
    return body.content ?? ''
  }
  return await r.text()
}

export function writeFile(ws: string, path: string, content: string): Promise<void> {
  return req('/api/fs/file', { method: 'PUT', body: JSON.stringify({ ws, path, content }) })
}

export function writeFileBase64(ws: string, path: string, contentBase64: string): Promise<void> {
  return req('/api/fs/file', { method: 'PUT', body: JSON.stringify({ ws, path, contentBase64 }) })
}

export function mkdir(ws: string, path: string): Promise<void> {
  return req('/api/fs/mkdir', { method: 'POST', body: JSON.stringify({ ws, path }) })
}

export function touch(ws: string, path: string): Promise<void> {
  return req('/api/fs/touch', { method: 'POST', body: JSON.stringify({ ws, path }) })
}

export function rename(ws: string, from: string, to: string): Promise<void> {
  return req('/api/fs/rename', { method: 'POST', body: JSON.stringify({ ws, from, to }) })
}

export function remove(ws: string, path: string): Promise<void> {
  return req('/api/fs/delete', { method: 'DELETE', body: JSON.stringify({ ws, path }) })
}

export interface BrowseEntry {
  name: string
  type: 'dir'
}

export interface BrowseResult {
  root: string
  abs: string
  path: string
  entries: BrowseEntry[]
  isAtRoot: boolean
  sandboxed: boolean
}

export function browse(path: string): Promise<BrowseResult> {
  return req(`/api/fs/browse?path=${encodeURIComponent(path)}`)
}

export function browseMkdir(path: string): Promise<void> {
  return req('/api/fs/browse/mkdir', { method: 'POST', body: JSON.stringify({ path }) })
}

export function addWorkspace(name: string, path: string): Promise<void> {
  return req('/api/workspaces', { method: 'POST', body: JSON.stringify({ name, path }) })
}

export function removeWorkspace(name: string): Promise<void> {
  return req(`/api/workspaces/${encodeURIComponent(name)}`, { method: 'DELETE' })
}
