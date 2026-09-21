import fs from 'node:fs'
import path from 'node:path'

export const SESSIONS_DIR = '.sessions'

export class SessionIdError extends Error {
  constructor(message = 'invalid session id') {
    super(message)
    this.name = 'SessionIdError'
  }
}

export interface SessionMeta {
  id: string
  title?: string
  status: 'regular' | 'archived'
  created: string
  modified: string
  messageCount: number
  streaming?: boolean
}

export interface StoredEntry {
  id: string
  parent_id: string | null
  format: string
  content: Record<string, unknown>
}

export interface StoredRepo {
  headId?: string | null
  messages: StoredEntry[]
}

export interface AssistantPart {
  type: string
  text?: string
  toolCallId?: string
  toolName?: string
  state?: string
  input?: unknown
  output?: unknown
  errorText?: string
}

export interface TurnRecord {
  userText: string
  assistantParts: AssistantPart[]
}

const locks = new Map<string, Promise<void>>()

export async function withSessionLock<T>(wsRoot: string, id: string, fn: () => T | Promise<T>): Promise<T> {
  const key = `${wsRoot}::${id}`
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(r => {
    release = r
  })
  locks.set(
    key,
    previous.then(() => current)
  )
  try {
    await previous
    return await fn()
  } finally {
    release()
    if (locks.get(key) === current) locks.delete(key)
  }
}

export function assertSessionId(id: string): string {
  if (!id || id.length > 200 || /[\\/]/.test(id) || id.includes('..') || id.includes('\0')) {
    throw new SessionIdError()
  }
  return id
}

function nowIso(): string {
  return new Date().toISOString()
}

export function sessionsRoot(wsRoot: string): string {
  return path.join(wsRoot, SESSIONS_DIR)
}

export function sessionDir(wsRoot: string, id: string): string {
  return path.join(sessionsRoot(wsRoot), assertSessionId(id))
}

export function sessionPiDir(wsRoot: string, id: string): string {
  return path.join(sessionDir(wsRoot, id), 'pi')
}

function metaPath(wsRoot: string, id: string): string {
  return path.join(sessionDir(wsRoot, id), 'meta.json')
}

function uiPath(wsRoot: string, id: string): string {
  return path.join(sessionDir(wsRoot, id), 'ui.json')
}

function transcriptPath(wsRoot: string, id: string): string {
  return path.join(sessionDir(wsRoot, id), 'transcript.md')
}

function activePath(wsRoot: string): string {
  return path.join(sessionsRoot(wsRoot), 'active')
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

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

export function titleFromUser(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  if (!trimmed) return 'Nouvelle session'
  return trimmed.length > 50 ? `${trimmed.slice(0, 47)}...` : trimmed
}

function emptyMeta(id: string): SessionMeta {
  const ts = nowIso()
  return { id, status: 'regular', created: ts, modified: ts, messageCount: 0 }
}

export function readMeta(wsRoot: string, id: string): SessionMeta | undefined {
  const raw = readJson<SessionMeta>(metaPath(wsRoot, id))
  if (!raw || raw.id !== id) return undefined
  return raw
}

export function upsertSession(wsRoot: string, id: string, patch?: Partial<SessionMeta>): SessionMeta {
  assertSessionId(id)
  fs.mkdirSync(sessionDir(wsRoot, id), { recursive: true })
  const current = readMeta(wsRoot, id) ?? emptyMeta(id)
  const next: SessionMeta = {
    ...current,
    ...patch,
    id,
    modified: nowIso()
  }
  writeAtomic(metaPath(wsRoot, id), JSON.stringify(next, null, 2) + '\n')
  return next
}

export function readUi(wsRoot: string, id: string): StoredRepo {
  const raw = readJson<StoredRepo>(uiPath(wsRoot, id))
  if (!raw || !Array.isArray(raw.messages)) return { messages: [] }
  return raw
}

export function writeUi(wsRoot: string, id: string, repo: StoredRepo): void {
  assertSessionId(id)
  fs.mkdirSync(sessionDir(wsRoot, id), { recursive: true })
  writeAtomic(uiPath(wsRoot, id), JSON.stringify(repo) + '\n')
}

export function listSessions(wsRoot: string): SessionMeta[] {
  const root = sessionsRoot(wsRoot)
  if (!fs.existsSync(root)) return []
  const out: SessionMeta[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const meta = readMeta(wsRoot, entry.name)
      if (meta) out.push(meta)
    } catch {
      // skip malformed ids
    }
  }
  out.sort((a, b) => b.modified.localeCompare(a.modified))
  return out
}

export function deleteSession(wsRoot: string, id: string): void {
  const dir = sessionDir(wsRoot, id)
  fs.rmSync(dir, { recursive: true, force: true })
  if (readActive(wsRoot) === id) writeActive(wsRoot, null)
}

export function readActive(wsRoot: string): string | undefined {
  try {
    const id = fs.readFileSync(activePath(wsRoot), 'utf8').trim()
    return id || undefined
  } catch {
    return undefined
  }
}

export function writeActive(wsRoot: string, id: string | null): void {
  fs.mkdirSync(sessionsRoot(wsRoot), { recursive: true })
  if (!id) {
    try {
      fs.unlinkSync(activePath(wsRoot))
    } catch {}
    return
  }
  writeAtomic(activePath(wsRoot), `${assertSessionId(id)}\n`)
}

function roleOf(entry: StoredEntry): string | undefined {
  const role = entry.content?.role
  return typeof role === 'string' ? role : undefined
}

function textOf(entry: StoredEntry): string {
  const parts = entry.content?.parts
  if (!Array.isArray(parts)) return ''
  return parts
    .filter(part => part && typeof part === 'object' && (part as { type?: string }).type === 'text')
    .map(part => String((part as { text?: string }).text ?? ''))
    .join('')
}

function newEntryId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function mergeTurn(repo: StoredRepo, turn: TurnRecord): StoredRepo {
  const last = repo.messages[repo.messages.length - 1]
  if (last && roleOf(last) === 'assistant') return repo

  let parentId = last?.id ?? null
  if (!last || roleOf(last) !== 'user') {
    const userId = newEntryId('user')
    repo.messages.push({
      id: userId,
      parent_id: parentId,
      format: 'ai-sdk/v6',
      content: { role: 'user', parts: [{ type: 'text', text: turn.userText }] }
    })
    parentId = userId
  }

  const assistantId = newEntryId('assistant')
  repo.messages.push({
    id: assistantId,
    parent_id: parentId,
    format: 'ai-sdk/v6',
    content: { role: 'assistant', parts: turn.assistantParts }
  })
  repo.headId = assistantId
  return repo
}

function transcriptFromRepo(meta: SessionMeta, repo: StoredRepo): string {
  const lines: string[] = [`# ${meta.title || meta.id}`, '']
  lines.push(`_id: ${meta.id}_`)
  lines.push(`_updated: ${meta.modified}_`, '')
  for (const entry of repo.messages) {
    const role = roleOf(entry) === 'user' ? 'User' : 'Assistant'
    lines.push(`## ${role}`, '')
    const text = textOf(entry).trim()
    if (text) lines.push(text, '')
    const parts = entry.content?.parts
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue
      const type = String((part as { type?: string }).type ?? '')
      if (!type.startsWith('tool-')) continue
      const name = (part as { toolName?: string }).toolName ?? type.slice(5)
      const input = (part as { input?: unknown }).input
      const summary =
        input && typeof input === 'object'
          ? JSON.stringify(input).slice(0, 200)
          : ''
      lines.push(`- tool \`${name}\`${summary ? ` ${summary}` : ''}`)
    }
    if (role === 'Assistant') lines.push('')
  }
  return lines.join('\n').trimEnd() + '\n'
}

export function rebuildTranscript(wsRoot: string, id: string): void {
  const meta = readMeta(wsRoot, id) ?? emptyMeta(id)
  const repo = readUi(wsRoot, id)
  writeAtomic(transcriptPath(wsRoot, id), transcriptFromRepo(meta, repo))
}

export function persistCompletedTurn(wsRoot: string, id: string, turn: TurnRecord): SessionMeta {
  assertSessionId(id)
  const repo = mergeTurn(readUi(wsRoot, id), turn)
  writeUi(wsRoot, id, repo)
  const current = readMeta(wsRoot, id) ?? emptyMeta(id)
  const next = upsertSession(wsRoot, id, {
    title: current.title || titleFromUser(turn.userText),
    messageCount: current.messageCount + 1,
    streaming: false
  })
  rebuildTranscript(wsRoot, id)
  return next
}

export const SESSIONS_PROMPT = `# Previous conversations
Chat transcripts live in \`.sessions/<id>/transcript.md\` at the workspace root. When the user refers to an earlier discussion, search those files with grep/read. Never create, edit, or delete anything under \`.sessions/\` — Vulcain manages that folder.`
