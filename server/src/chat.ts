import { createAgentSession, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent'
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { createUIMessageStream, pipeUIMessageStreamToResponse } from 'ai'
import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { findWorkspace, loadConfig, type ResolvedWorkspace } from './config.js'
import { piAgentDir } from './pisync.js'
import {
  SessionIdError,
  persistCompletedTurn,
  readActive,
  readMeta,
  readUi,
  rebuildTranscript,
  sessionPiDir,
  upsertSession,
  writeActive,
  writeUi,
  withSessionLock,
  listSessions as listStoredSessions,
  deleteSession as deleteStoredSession,
  type AssistantPart,
  type StoredRepo,
  type TurnRecord
} from './sessions.js'

export interface ToolCallInfo {
  toolCallId: string
  toolName: string
  title?: string
  kind?: string
  status?: 'pending' | 'in_progress' | 'completed' | 'failed'
  args?: unknown
  result?: unknown
  isError?: boolean
}

export type ChatSessionEvent =
  | { type: 'text_delta'; contentIndex: number; delta: string }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'tool_call'; toolCall: ToolCallInfo }
  | { type: 'tool_call_update'; toolCall: ToolCallInfo }
  | { type: 'tool_result'; toolCall: ToolCallInfo }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface ChatUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  totalTokens: number
}

export interface ChatContextUsage {
  tokens: number | null
  contextWindow: number
  percent: number | null
}

export interface ChatSessionInfo {
  id: string
  title?: string
  modified: string
  messageCount: number
}

export interface ChatSession {
  readonly sessionId: string
  readonly isStreaming: boolean
  prompt(text: string): Promise<void>
  abort(): Promise<void>
  subscribe(listener: (event: ChatSessionEvent) => void): () => void
  commands(): Promise<{ name: string; description?: string }[]>
  getUsage(): { usage: ChatUsage; contextUsage: ChatContextUsage }
  dispose(): void
}

export interface ChatBackend {
  createSession(cwd: string, threadId?: string, wsName?: string): Promise<ChatSession>
  listSessions?(wsName: string, cwd: string): Promise<ChatSessionInfo[]>
}

const KIND_BY_TOOL: Record<string, string> = {
  read: 'read',
  write: 'edit',
  edit: 'edit',
  bash: 'bash',
  grep: 'search',
  find: 'search',
  ls: 'search',
  web_search: 'search',
  web_research: 'fetch',
  web_read: 'fetch',
  browser_screenshot: 'other'
}

function titleFor(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const argPath = (args as Record<string, unknown>).path
  if (typeof argPath === 'string') return `${toolName} ${argPath}`
  const cmd = (args as Record<string, unknown>).command
  if (typeof cmd === 'string') return `${toolName} ${cmd.slice(0, 60)}`
  const query = (args as Record<string, unknown>).query
  if (typeof query === 'string') return `${toolName} "${query.slice(0, 60)}"`
  return undefined
}

function textFromResult(result: unknown): string {
  if (result === null || result === undefined) return ''
  if (typeof result === 'string') return result
  if (typeof result !== 'object') return JSON.stringify(result)
  const content = (result as Record<string, unknown>).content
  if (Array.isArray(content)) {
    return content
      .map(block =>
        block && typeof block === 'object' && (block as { type?: string }).type === 'text'
          ? String((block as { text?: string }).text ?? '')
          : ''
      )
      .join('')
  }
  return JSON.stringify(result).slice(0, 50000)
}

const MAX_OUTPUT_CHARS = 50000

class PiChatSession implements ChatSession {
  constructor(private readonly session: AgentSession) {}

  get sessionId(): string {
    return this.session.sessionId
  }

  get isStreaming(): boolean {
    return this.session.isStreaming
  }

  async prompt(text: string): Promise<void> {
    await this.session.prompt(text)
  }

  async abort(): Promise<void> {
    await this.session.abort()
  }

  subscribe(listener: (event: ChatSessionEvent) => void): () => void {
    return this.session.subscribe((event: AgentSessionEvent) => {
      switch (event.type) {
        case 'message_update': {
          const ev = event.assistantMessageEvent
          if (ev.type === 'text_delta') {
            listener({ type: 'text_delta', contentIndex: ev.contentIndex, delta: ev.delta })
          } else if (ev.type === 'thinking_delta') {
            listener({ type: 'reasoning_delta', delta: ev.delta })
          } else if (ev.type === 'toolcall_end') {
            const args = ev.toolCall.arguments
            listener({
              type: 'tool_call',
              toolCall: {
                toolCallId: ev.toolCall.id,
                toolName: ev.toolCall.name,
                title: titleFor(ev.toolCall.name, args),
                kind: KIND_BY_TOOL[ev.toolCall.name] ?? 'other',
                status: 'pending',
                args
              }
            })
          } else if (ev.type === 'error') {
            listener({ type: 'error', message: 'agent_error' })
          }
          break
        }
        case 'tool_execution_start': {
          listener({
            type: 'tool_call_update',
            toolCall: {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
              status: 'in_progress'
            }
          })
          break
        }
        case 'tool_execution_end': {
          const text = textFromResult(event.result).slice(0, MAX_OUTPUT_CHARS)
          listener({
            type: 'tool_result',
            toolCall: {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              status: event.isError ? 'failed' : 'completed',
              isError: event.isError,
              result: text
            }
          })
          break
        }
        case 'agent_settled': {
          listener({ type: 'done' })
          break
        }
      }
    })
  }

  async commands(): Promise<{ name: string; description?: string }[]> {
    const out: { name: string; description?: string }[] = []
    for (const command of this.session.extensionRunner.getRegisteredCommands()) {
      out.push({ name: command.invocationName, description: command.description })
    }
    for (const template of this.session.promptTemplates) {
      out.push({ name: template.name, description: template.description })
    }
    for (const skill of this.session.resourceLoader.getSkills().skills) {
      out.push({ name: `skill:${skill.name}`, description: skill.description })
    }
    return out
  }

  getUsage(): { usage: ChatUsage; contextUsage: ChatContextUsage } {
    const stats = this.session.getSessionStats()
    const context = this.session.getContextUsage()
    return {
      usage: {
        inputTokens: stats.tokens.input,
        outputTokens: stats.tokens.output,
        cachedInputTokens: stats.tokens.cacheRead,
        totalTokens: stats.tokens.total
      },
      contextUsage: context
        ? { tokens: context.tokens, contextWindow: context.contextWindow, percent: context.percent }
        : { tokens: null, contextWindow: 0, percent: null }
    }
  }

  dispose(): void {
    this.session.dispose()
  }
}

export class PiChatBackend implements ChatBackend {
  private modelRuntime: ModelRuntime | null = null
  private modelRuntimePromise: Promise<ModelRuntime> | null = null

  private async getModelRuntime(): Promise<ModelRuntime> {
    if (this.modelRuntime) return this.modelRuntime
    if (this.modelRuntimePromise) return this.modelRuntimePromise
    const agentDir = piAgentDir()
    this.modelRuntimePromise = ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath: path.join(agentDir, 'models.json')
    }).then(runtime => {
      this.modelRuntime = runtime
      this.modelRuntimePromise = null
      return runtime
    })
    return this.modelRuntimePromise
  }

  async createSession(cwd: string, threadId?: string): Promise<ChatSession> {
    const modelRuntime = await this.getModelRuntime()
    let sessionManager: SessionManager | undefined
    if (threadId) {
      const dir = sessionPiDir(cwd, threadId)
      fs.mkdirSync(dir, { recursive: true })
      const infos = await SessionManager.list(cwd, dir)
      if (infos.length > 0) {
        sessionManager = SessionManager.open(infos[0].path, dir, cwd)
      } else {
        sessionManager = SessionManager.create(cwd, dir)
      }
    }
    const { session } = await createAgentSession({
      cwd,
      modelRuntime,
      ...(sessionManager ? { sessionManager } : {})
    })
    return new PiChatSession(session)
  }
}

interface FakeState {
  created: number
  promptCount: number
  title?: string
}

class FakeChatSession implements ChatSession {
  private listeners = new Set<(event: ChatSessionEvent) => void>()
  private disposed = false
  private aborted = false
  private streaming = false

  constructor(private readonly cwd: string, private readonly state: FakeState) {}

  get sessionId(): string {
    return `fake-${this.state.created}`
  }

  get isStreaming(): boolean {
    return this.streaming
  }

  private emit(event: ChatSessionEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private async pause(slow: boolean): Promise<void> {
    if (!slow) return
    for (let i = 0; i < 8; i += 1) {
      if (this.aborted) return
      await new Promise(resolve => setTimeout(resolve, 80))
    }
  }

  async prompt(text: string): Promise<void> {
    this.aborted = false
    this.streaming = true
    this.state.promptCount += 1
    if (!this.state.title) {
      this.state.title = `echo: ${text.slice(0, 40)}`
    }
    const slow = /^\s*slow\b/i.test(text)
    try {
      await this.pause(slow)
      if (this.aborted) return
      const prefix = `echo: ${text}`
      const chunks = [prefix.slice(0, 6), prefix.slice(6)]
      for (const delta of chunks) {
        this.emit({ type: 'text_delta', contentIndex: 0, delta })
        await this.pause(slow)
        if (this.aborted) return
      }
      const filePath = `${this.cwd}/welcome.md`
      this.emit({
        type: 'tool_call',
        toolCall: {
          toolCallId: 't1',
          toolName: 'read',
          title: `Read ${filePath}`,
          kind: 'read',
          status: 'pending',
          args: { path: filePath }
        }
      })
      await this.pause(slow)
      if (this.aborted) return
      this.emit({
        type: 'tool_result',
        toolCall: { toolCallId: 't1', toolName: 'read', status: 'completed', result: 'file contents here' }
      })
      await this.pause(slow)
      if (this.aborted) return
      this.emit({ type: 'text_delta', contentIndex: 1, delta: 'après lecture' })
      this.emit({ type: 'done' })
    } finally {
      this.streaming = false
    }
  }

  async abort(): Promise<void> {
    this.aborted = true
    this.streaming = false
  }

  subscribe(listener: (event: ChatSessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async commands(): Promise<{ name: string; description?: string }[]> {
    return [
      { name: 'model', description: 'Changer de modèle' },
      { name: 'compact', description: 'Compacter la session' }
    ]
  }

  getUsage(): { usage: ChatUsage; contextUsage: ChatContextUsage } {
    return {
      usage: { inputTokens: 42, outputTokens: 7, cachedInputTokens: 10, totalTokens: 49 },
      contextUsage: { tokens: 12000, contextWindow: 200000, percent: 6.129 }
    }
  }

  dispose(): void {
    this.disposed = true
  }
}

class FakeChatBackend implements ChatBackend {
  private readonly sessions = new Map<string, FakeChatSession>()
  private readonly threads = new Map<string, FakeState>()

  private threadKey(cwd: string, threadId?: string): string {
    return threadId ? `${cwd}::${threadId}` : cwd
  }

  async createSession(cwd: string, threadId?: string): Promise<ChatSession> {
    let state: FakeState
    if (threadId) {
      state = this.threads.get(threadId) ?? { created: this.threads.size + 1, promptCount: 0 }
      this.threads.set(threadId, state)
    } else {
      state = { created: this.sessions.size + 1, promptCount: 0 }
    }
    const key = this.threadKey(cwd, threadId)
    const existing = this.sessions.get(key)
    if (existing) {
      existing.dispose()
      this.sessions.delete(key)
    }
    const session = new FakeChatSession(cwd, state)
    this.sessions.set(key, session)
    return session
  }

  async listSessions(_wsName: string): Promise<ChatSessionInfo[]> {
    const now = new Date().toISOString()
    return [...this.threads.entries()].map(([id, state]) => ({
      id,
      title: state.title || undefined,
      modified: now,
      messageCount: state.promptCount
    }))
  }
}

interface ChatRequestBody {
  workspace?: string
  sessionId?: string
  reset?: boolean
  messages?: {
    role?: string
    content?: string | Array<{ type?: string; text?: string }>
    parts?: Array<{ type?: string; text?: string }>
  }[]
}

class TurnBuilder {
  userText = ''
  private readonly parts: AssistantPart[] = []
  private textPart: AssistantPart | null = null
  private reasoningPart: AssistantPart | null = null
  private readonly tools = new Map<string, AssistantPart>()

  apply(event: ChatSessionEvent): void {
    switch (event.type) {
      case 'text_delta':
        this.reasoningPart = null
        if (!this.textPart) {
          this.textPart = { type: 'text', text: '' }
          this.parts.push(this.textPart)
        }
        this.textPart.text = `${this.textPart.text ?? ''}${event.delta}`
        break
      case 'reasoning_delta':
        this.textPart = null
        if (!this.reasoningPart) {
          this.reasoningPart = { type: 'reasoning', text: '' }
          this.parts.push(this.reasoningPart)
        }
        this.reasoningPart.text = `${this.reasoningPart.text ?? ''}${event.delta}`
        break
      case 'tool_call': {
        this.textPart = null
        this.reasoningPart = null
        const part: AssistantPart = {
          type: `tool-${event.toolCall.toolName}`,
          toolCallId: event.toolCall.toolCallId,
          toolName: event.toolCall.toolName,
          state: 'input-available',
          input: event.toolCall.args
        }
        this.tools.set(event.toolCall.toolCallId, part)
        this.parts.push(part)
        break
      }
      case 'tool_result': {
        const part = this.tools.get(event.toolCall.toolCallId)
        if (!part) break
        part.state = event.toolCall.isError ? 'output-error' : 'output-available'
        if (event.toolCall.isError) part.errorText = String(event.toolCall.result ?? '')
        else part.output = event.toolCall.result
        break
      }
      default:
        break
    }
  }

  toTurn(): TurnRecord {
    return { userText: this.userText, assistantParts: this.parts }
  }
}

function lastUserText(body: ChatRequestBody): string | undefined {
  const messages = body.messages ?? []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    if (Array.isArray(message.parts)) {
      const text = message.parts
        .filter(part => part?.type === 'text')
        .map(part => part.text ?? '')
        .join('')
      if (text.trim()) return text
    }
    const content = message.content
    if (typeof content === 'string' && content.trim()) return content
    if (Array.isArray(content)) {
      const text = content
        .filter(part => part?.type === 'text')
        .map(part => part.text ?? '')
        .join('')
      if (text.trim()) return text
    }
    return undefined
  }
  return undefined
}

const SESSION_TTL_MS = 20 * 60 * 1000
const SESSION_SWEEP_MS = 5 * 60 * 1000
const HEARTBEAT_MS = 15_000

interface LiveTurn {
  session: ChatSession
  turn: TurnBuilder
  events: ChatSessionEvent[]
  listeners: Set<(event: ChatSessionEvent) => void>
  promptPromise: Promise<void>
}

async function streamLiveToReply(
  reply: FastifyReply,
  live: LiveTurn,
  aborting: Set<string>,
  key: string
): Promise<void> {
  const session = live.session
  const stream = createUIMessageStream({
    async execute({ writer }) {
      const write = (part: Parameters<typeof writer.write>[0]): void => {
        if (reply.raw.destroyed) return
        try {
          writer.write(part)
        } catch {
          // client gone; generation continues in the background
        }
      }
      write({ type: 'start' })
      const beat = setInterval(() => {
        write({ type: 'message-metadata', messageMetadata: { custom: { keepalive: true } } })
      }, HEARTBEAT_MS)
      beat.unref()
      let textId: string | undefined
      let textContentIndex: number | undefined
      let textSeq = 0
      let reasoningId: string | undefined
      let reasoningSeq = 0
      let finished = false
      const closeText = () => {
        if (!textId) return
        write({ type: 'text-end', id: textId })
        textId = undefined
        textContentIndex = undefined
      }
      const closeReasoning = () => {
        if (!reasoningId) return
        write({ type: 'reasoning-end', id: reasoningId })
        reasoningId = undefined
      }
      const closeParts = () => {
        closeReasoning()
        closeText()
      }
      const ensureText = (contentIndex: number) => {
        closeReasoning()
        if (textId && textContentIndex !== contentIndex) closeText()
        if (textId) return
        textId = `text-${textSeq}`
        textSeq += 1
        textContentIndex = contentIndex
        write({ type: 'text-start', id: textId })
      }
      const ensureReasoning = () => {
        closeText()
        if (reasoningId) return
        reasoningId = `reasoning-${reasoningSeq}`
        reasoningSeq += 1
        write({ type: 'reasoning-start', id: reasoningId })
      }
      const finish = (outcome: 'completed' | 'failed' | 'aborted', error?: string) => {
        if (finished) return
        finished = true
        closeParts()
        if (outcome === 'completed') {
          const { usage, contextUsage } = session.getUsage()
          write({ type: 'message-metadata', messageMetadata: { custom: { usage, contextUsage } } })
        }
        try {
          writer.setOutcome(
            outcome === 'completed'
              ? { status: 'completed' }
              : outcome === 'aborted'
                ? { status: 'aborted' }
                : { status: 'failed', error }
          )
        } catch {}
        if (outcome !== 'aborted') write({ type: 'finish', finishReason: outcome === 'failed' ? 'error' : 'stop' })
      }
      const handle = (event: ChatSessionEvent) => {
        switch (event.type) {
          case 'text_delta':
            ensureText(event.contentIndex)
            write({ type: 'text-delta', id: textId!, delta: event.delta })
            break
          case 'reasoning_delta':
            ensureReasoning()
            write({ type: 'reasoning-delta', id: reasoningId!, delta: event.delta })
            break
          case 'tool_call':
            closeParts()
            write({
              type: 'tool-input-available',
              toolCallId: event.toolCall.toolCallId,
              toolName: event.toolCall.toolName,
              input: event.toolCall.args,
              toolMetadata: { title: event.toolCall.title, kind: event.toolCall.kind }
            })
            break
          case 'tool_result':
            if (event.toolCall.isError) {
              write({
                type: 'tool-output-error',
                toolCallId: event.toolCall.toolCallId,
                errorText: String(event.toolCall.result ?? 'tool error')
              })
            } else {
              write({
                type: 'tool-output-available',
                toolCallId: event.toolCall.toolCallId,
                output: event.toolCall.result
              })
            }
            break
          case 'error':
            write({ type: 'error', errorText: event.message })
            break
          case 'done':
            finish('completed')
            break
        }
      }
      const snapshot = live.events.slice()
      for (const event of snapshot) handle(event)
      live.listeners.add(handle)
      for (let i = snapshot.length; i < live.events.length; i += 1) handle(live.events[i]!)
      try {
        await live.promptPromise
        if (!finished) finish(aborting.has(key) ? 'aborted' : 'completed')
      } catch (err) {
        if (finished) return
        const message = err instanceof Error ? err.message : String(err)
        if (aborting.has(key)) {
          finish('aborted')
        } else {
          write({ type: 'error', errorText: message })
          finish('failed', message)
        }
      } finally {
        clearInterval(beat)
        live.listeners.delete(handle)
      }
    },
    onError: (err: unknown) => (err instanceof Error ? err.message : String(err))
  })

  reply.hijack()
  void pipeUIMessageStreamToResponse({ response: reply.raw, stream }).catch(() => {})
  try {
    await live.promptPromise
  } catch {}
}

interface ChatDoneEvent {
  type: 'session-done'
  workspace: string
  sessionId: string
  title?: string
}

export function registerChat(app: FastifyInstance, backend?: ChatBackend): void {
  const active = backend ?? (process.env.VULCAIN_CHAT_BACKEND === 'fake' ? new FakeChatBackend() : new PiChatBackend())
  const sessions = new Map<string, { chat: ChatSession; lastUsed: number }>()
  const liveTurns = new Map<string, LiveTurn>()
  const aborting = new Set<string>()
  const eventClients = new Set<{ send: (data: string) => void; readyState: number; OPEN: number; on: (ev: string, fn: () => void) => void }>()

  const sessionKey = (wsName: string, threadId: string | undefined): string => `${wsName}:${threadId ?? ''}`

  const dropSession = (key: string): void => {
    liveTurns.delete(key)
    const entry = sessions.get(key)
    if (!entry) return
    entry.chat.dispose()
    sessions.delete(key)
  }

  const broadcastDone = (event: ChatDoneEvent): void => {
    const payload = JSON.stringify(event)
    for (const client of eventClients) {
      if (client.readyState === client.OPEN) client.send(payload)
    }
  }

  const persistTurn = async (ws: ResolvedWorkspace, sessionId: string | undefined, turn: TurnRecord): Promise<void> => {
    if (!sessionId) return
    try {
      const meta = await withSessionLock(ws.root, sessionId, () => persistCompletedTurn(ws.root, sessionId, turn))
      broadcastDone({ type: 'session-done', workspace: ws.name, sessionId, title: meta.title })
    } catch (err) {
      if (err instanceof SessionIdError) return
      console.error('[chat] persist turn failed', err)
    }
  }

  async function getSession(ws: ResolvedWorkspace, threadId: string | undefined, reset: boolean): Promise<ChatSession> {
    const key = sessionKey(ws.name, threadId)
    let entry = sessions.get(key)
    if (entry && reset) {
      entry.chat.dispose()
      sessions.delete(key)
      entry = undefined
    }
    if (!entry) {
      const chat = await active.createSession(ws.root, threadId, ws.name)
      entry = { chat, lastUsed: Date.now() }
      sessions.set(key, entry)
    }
    entry.lastUsed = Date.now()
    return entry.chat
  }

  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of sessions) {
      if (now - entry.lastUsed > SESSION_TTL_MS) {
        entry.chat.dispose()
        sessions.delete(key)
      }
    }
  }, SESSION_SWEEP_MS)
  sweep.unref()

  app.post('/api/chat', async (request: FastifyRequest<{ Body: ChatRequestBody }>, reply) => {
    const cfg = loadConfig()
    const ws = findWorkspace(cfg, request.body?.workspace ?? '')
    if (!ws) {
      reply.code(400).send({ error: 'unknown workspace' })
      return
    }

    const text = lastUserText(request.body ?? {})
    if (!text) {
      reply.code(400).send({ error: 'no user message' })
      return
    }

    const threadId = request.body?.sessionId
    const key = sessionKey(ws.name, threadId)
    const reset = Boolean(request.body?.reset)

    let session: ChatSession
    try {
      session = await getSession(ws, threadId, reset)
    } catch (err) {
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
      return
    }

    const inflight = liveTurns.get(key)
    if (session.isStreaming && inflight) {
      await streamLiveToReply(reply, inflight, aborting, key)
      return
    }
    if (session.isStreaming) {
      aborting.add(key)
      try {
        await session.abort()
      } catch {}
      dropSession(key)
      session = await getSession(ws, threadId, false)
    }

    aborting.delete(key)
    const chat = session
    if (threadId) {
      try {
        upsertSession(ws.root, threadId, { streaming: true })
      } catch (err) {
        if (err instanceof SessionIdError) {
          reply.code(400).send({ error: err.message })
          return
        }
        throw err
      }
    }

    const turn = new TurnBuilder()
    turn.userText = text
    const events: ChatSessionEvent[] = []
    const listeners = new Set<(event: ChatSessionEvent) => void>()
    const unsubAll = session.subscribe(event => {
      turn.apply(event)
      events.push(event)
      for (const listener of listeners) listener(event)
    })
    const promptPromise = session.prompt(text).finally(() => unsubAll())
    const live: LiveTurn = { session, turn, events, listeners, promptPromise }
    liveTurns.set(key, live)
    await streamLiveToReply(reply, live, aborting, key)
    const stillCurrent = sessions.get(key)?.chat === chat
    const wasAborted = aborting.delete(key)
    liveTurns.delete(key)
    if (!wasAborted && stillCurrent) await persistTurn(ws, threadId, turn.toTurn())
    else if (threadId) {
      try {
        upsertSession(ws.root, threadId, { streaming: false })
      } catch {}
    }
  })

  app.post('/api/chat/reset', async (request, reply) => {
    const body = (request.body as { workspace?: string; sessionId?: string } | undefined) ?? {}
    const cfg = loadConfig()
    const ws = findWorkspace(cfg, body.workspace ?? '')
    if (!ws) {
      reply.code(400).send({ error: 'unknown workspace' })
      return
    }
    const entry = sessions.get(sessionKey(ws.name, body.sessionId))
    if (entry) {
      entry.chat.dispose()
      sessions.delete(sessionKey(ws.name, body.sessionId))
    }
    reply.send({ ok: true })
  })

  app.post('/api/chat/abort', async (request, reply) => {
    const body = (request.body as { workspace?: string; sessionId?: string } | undefined) ?? {}
    const ws = findWorkspace(loadConfig(), body.workspace ?? '')
    if (!ws) {
      reply.code(400).send({ error: 'unknown workspace' })
      return
    }
    const key = sessionKey(ws.name, body.sessionId)
    const prefix = `${ws.name}:`
    const keys = new Set<string>([key])
    for (const [k, e] of sessions) {
      if (k.startsWith(prefix) && e.chat.isStreaming) keys.add(k)
    }
    for (const k of keys) aborting.add(k)
    await Promise.all(
      [...keys].map(async k => {
        const entry = sessions.get(k)
        if (!entry) return
        try {
          await entry.chat.abort()
        } catch {}
        if (entry.chat.isStreaming) dropSession(k)
      })
    )
    reply.send({ ok: true })
  })

  app.get('/api/chat/events', { websocket: true }, (sock: { send: (data: string) => void; readyState: number; OPEN: number; on: (ev: string, fn: () => void) => void }) => {
    eventClients.add(sock)
    sock.on('close', () => eventClients.delete(sock))
  })

  app.get('/api/chat/sessions', async (request, reply) => {
    const ws = findWorkspace(loadConfig(), (request.query as { workspace?: string }).workspace ?? '')
    if (!ws) {
      reply.code(400).send({ error: 'unknown workspace' })
      return
    }
    try {
      const list = listStoredSessions(ws.root).map(meta => ({
        id: meta.id,
        title: meta.title,
        modified: meta.modified,
        messageCount: meta.messageCount
      }))
      reply.send({ sessions: list, activeId: readActive(ws.root) ?? null })
    } catch (err) {
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.put('/api/chat/active', async (request, reply) => {
    const body = (request.body as { workspace?: string; sessionId?: string | null } | undefined) ?? {}
    const ws = findWorkspace(loadConfig(), body.workspace ?? '')
    if (!ws) {
      reply.code(400).send({ error: 'unknown workspace' })
      return
    }
    try {
      writeActive(ws.root, body.sessionId ?? null)
      reply.send({ ok: true, activeId: readActive(ws.root) ?? null })
    } catch (err) {
      const status = err instanceof SessionIdError ? 400 : 500
      reply.code(status).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.put('/api/chat/sessions/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id
    const body = (request.body as { workspace?: string; title?: string; status?: 'regular' | 'archived' } | undefined) ?? {}
    const ws = findWorkspace(loadConfig(), body.workspace ?? '')
    if (!ws) {
      reply.code(400).send({ error: 'unknown workspace' })
      return
    }
    try {
      const patch: { title?: string; status?: 'regular' | 'archived' } = {}
      if (typeof body.title === 'string') patch.title = body.title
      if (body.status === 'regular' || body.status === 'archived') patch.status = body.status
      const meta = upsertSession(ws.root, id, patch)
      reply.send({ session: { id: meta.id, title: meta.title, modified: meta.modified, messageCount: meta.messageCount } })
    } catch (err) {
      const status = err instanceof SessionIdError ? 400 : 500
      reply.code(status).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/chat/sessions/:id/messages', async (request, reply) => {
    const id = (request.params as { id: string }).id
    const ws = findWorkspace(loadConfig(), (request.query as { workspace?: string }).workspace ?? '')
    if (!ws) {
      reply.code(400).send({ error: 'unknown workspace' })
      return
    }
    try {
      reply.send(readUi(ws.root, id))
    } catch (err) {
      const status = err instanceof SessionIdError ? 400 : 500
      reply.code(status).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.put('/api/chat/sessions/:id/messages', async (request, reply) => {
    const id = (request.params as { id: string }).id
    const body = (request.body as { workspace?: string; headId?: string | null; messages?: unknown } | undefined) ?? {}
    const ws = findWorkspace(loadConfig(), body.workspace ?? '')
    if (!ws) {
      reply.code(400).send({ error: 'unknown workspace' })
      return
    }
    if (!Array.isArray(body.messages)) {
      reply.code(400).send({ error: 'messages array required' })
      return
    }
    try {
      await withSessionLock(ws.root, id, () => {
        if (readMeta(ws.root, id)?.streaming) return
        const current = readUi(ws.root, id)
        const incoming = body.messages as StoredRepo['messages']
        if (current.messages.length > 0 && incoming.length < current.messages.length) return
        upsertSession(ws.root, id)
        writeUi(ws.root, id, { headId: body.headId ?? null, messages: incoming })
        rebuildTranscript(ws.root, id)
      })
      reply.send({ ok: true })
    } catch (err) {
      const status = err instanceof SessionIdError ? 400 : 500
      reply.code(status).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/chat/sessions/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id
    const ws = findWorkspace(loadConfig(), (request.query as { workspace?: string }).workspace ?? '')
    if (!ws) {
      reply.code(400).send({ error: 'unknown workspace' })
      return
    }
    try {
      const key = sessionKey(ws.name, id)
      const entry = sessions.get(key)
      if (entry) {
        entry.chat.dispose()
        sessions.delete(key)
      }
      deleteStoredSession(ws.root, id)
      reply.send({ ok: true })
    } catch (err) {
      const status = err instanceof SessionIdError ? 400 : 500
      reply.code(status).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/chat/commands', async (request, reply) => {
    const cfg = loadConfig()
    const ws = findWorkspace(cfg, (request.query as { workspace?: string }).workspace ?? '')
    if (!ws) {
      reply.code(400).send({ error: 'unknown workspace' })
      return
    }
    const sessionId = (request.query as { sessionId?: string }).sessionId
    let session: ChatSession
    try {
      session = await getSession(ws, sessionId, false)
    } catch (err) {
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
      return
    }
    reply.send({ commands: await session.commands() })
  })
}