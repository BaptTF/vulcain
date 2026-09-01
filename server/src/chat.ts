import { createAgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { createUIMessageStream, pipeUIMessageStreamToResponse } from 'ai'
import path from 'node:path'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { findWorkspace, loadConfig, type ResolvedWorkspace } from './config.js'
import { piAgentDir } from './pisync.js'

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

export interface ChatSession {
  readonly sessionId: string
  readonly isStreaming: boolean
  prompt(text: string): Promise<void>
  abort(): Promise<void>
  subscribe(listener: (event: ChatSessionEvent) => void): () => void
  commands(): Promise<{ name: string; description?: string }[]>
  dispose(): void
}

export interface ChatBackend {
  createSession(cwd: string): Promise<ChatSession>
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

  async createSession(cwd: string): Promise<ChatSession> {
    const modelRuntime = await this.getModelRuntime()
    const { session } = await createAgentSession({ cwd, modelRuntime })
    return new PiChatSession(session)
  }
}

interface FakeState {
  created: number
  promptCount: number
}

class FakeChatSession implements ChatSession {
  private listeners = new Set<(event: ChatSessionEvent) => void>()
  private disposed = false

  constructor(private readonly cwd: string, private readonly state: FakeState) {}

  get sessionId(): string {
    return `fake-${this.state.created}`
  }

  get isStreaming(): boolean {
    return false
  }

  private emit(event: ChatSessionEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  async prompt(text: string): Promise<void> {
    this.state.promptCount += 1
    const prefix = `echo: ${text}`
    const chunks = [prefix.slice(0, 6), prefix.slice(6)]
    for (const delta of chunks) {
      this.emit({ type: 'text_delta', contentIndex: 0, delta })
    }
    const path = `${this.cwd}/welcome.md`
    this.emit({
      type: 'tool_call',
      toolCall: { toolCallId: 't1', toolName: 'read', title: `Read ${path}`, kind: 'read', status: 'pending', args: { path } }
    })
    this.emit({
      type: 'tool_result',
      toolCall: { toolCallId: 't1', toolName: 'read', status: 'completed', result: 'file contents here' }
    })
    this.emit({ type: 'done' })
  }

  async abort(): Promise<void> {}

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

  dispose(): void {
    this.disposed = true
  }
}

class FakeChatBackend implements ChatBackend {
  private readonly sessions = new Map<string, FakeChatSession>()

  async createSession(cwd: string): Promise<ChatSession> {
    const existing = this.sessions.get(cwd)
    if (existing) {
      existing.dispose()
      this.sessions.delete(cwd)
    }
    const session = new FakeChatSession(cwd, { created: this.sessions.size + 1, promptCount: 0 })
    this.sessions.set(cwd, session)
    return session
  }
}

interface ChatRequestBody {
  workspace?: string
  reset?: boolean
  messages?: {
    role?: string
    content?: string | Array<{ type?: string; text?: string }>
    parts?: Array<{ type?: string; text?: string }>
  }[]
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

export function registerChat(app: FastifyInstance, backend?: ChatBackend): void {
  const active = backend ?? (process.env.VULCAIN_CHAT_BACKEND === 'fake' ? new FakeChatBackend() : new PiChatBackend())
  const sessions = new Map<string, ChatSession>()

  async function getSession(ws: ResolvedWorkspace, reset: boolean): Promise<ChatSession> {
    let session = sessions.get(ws.name)
    if (session && reset) {
      session.dispose()
      sessions.delete(ws.name)
      session = undefined
    }
    if (!session) {
      session = await active.createSession(ws.root)
      sessions.set(ws.name, session)
    }
    return session
  }

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

    let session: ChatSession
    try {
      session = await getSession(ws, Boolean(request.body?.reset))
    } catch (err) {
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
      return
    }

    if (session.isStreaming) {
      reply.code(409).send({ error: 'agent already streaming' })
      return
    }

    let aborted = false
    const onClose = () => {
      aborted = true
      void session.abort()
    }
    request.raw.once('close', onClose)

    const stream = createUIMessageStream({
      async execute({ writer }) {
        writer.write({ type: 'start' })
        let textStarted = false
        let reasoningStarted = false
        let finished = false
        const closeParts = () => {
          if (reasoningStarted) writer.write({ type: 'reasoning-end', id: 'reasoning' })
          if (textStarted) writer.write({ type: 'text-end', id: 'text' })
          reasoningStarted = false
          textStarted = false
        }
        const finish = (outcome: 'completed' | 'failed' | 'aborted', error?: string) => {
          if (finished) return
          finished = true
          closeParts()
          writer.setOutcome(
            outcome === 'completed'
              ? { status: 'completed' }
              : outcome === 'aborted'
                ? { status: 'aborted' }
                : { status: 'failed', error }
          )
          if (outcome !== 'aborted') writer.write({ type: 'finish', finishReason: outcome === 'failed' ? 'error' : 'stop' })
        }
        const unsubscribe = session.subscribe(event => {
          switch (event.type) {
            case 'text_delta':
              if (!textStarted) {
                writer.write({ type: 'text-start', id: 'text' })
                textStarted = true
              }
              writer.write({ type: 'text-delta', id: 'text', delta: event.delta })
              break
            case 'reasoning_delta':
              if (!reasoningStarted) {
                writer.write({ type: 'reasoning-start', id: 'reasoning' })
                reasoningStarted = true
              }
              writer.write({ type: 'reasoning-delta', id: 'reasoning', delta: event.delta })
              break
            case 'tool_call':
              writer.write({
                type: 'tool-input-available',
                toolCallId: event.toolCall.toolCallId,
                toolName: event.toolCall.toolName,
                input: event.toolCall.args,
                toolMetadata: { title: event.toolCall.title, kind: event.toolCall.kind }
              })
              break
            case 'tool_result':
              if (event.toolCall.isError) {
                writer.write({
                  type: 'tool-output-error',
                  toolCallId: event.toolCall.toolCallId,
                  errorText: String(event.toolCall.result ?? 'tool error')
                })
              } else {
                writer.write({
                  type: 'tool-output-available',
                  toolCallId: event.toolCall.toolCallId,
                  output: event.toolCall.result
                })
              }
              break
            case 'error':
              writer.write({ type: 'error', errorText: event.message })
              break
            case 'done':
              finish('completed')
              break
          }
        })

        try {
          await session.prompt(text)
          if (!finished) finish(aborted ? 'aborted' : 'completed')
        } catch (err) {
          if (finished) return
          const message = err instanceof Error ? err.message : String(err)
          if (aborted) {
            finish('aborted')
          } else {
            writer.write({ type: 'error', errorText: message })
            finish('failed', message)
          }
        } finally {
          unsubscribe()
        }
      },
      onError: (err: unknown) => (err instanceof Error ? err.message : String(err))
    })

    await pipeUIMessageStreamToResponse({ response: reply.raw, stream })
    request.raw.removeListener('close', onClose)
  })

  app.post('/api/chat/reset', async (request, reply) => {
    const cfg = loadConfig()
    const ws = findWorkspace(cfg, (request.body as { workspace?: string } | undefined)?.workspace ?? '')
    if (!ws) {
      reply.code(400).send({ error: 'unknown workspace' })
      return
    }
    const session = sessions.get(ws.name)
    if (session) {
      session.dispose()
      sessions.delete(ws.name)
    }
    reply.send({ ok: true })
  })

  app.get('/api/chat/commands', async (request, reply) => {
    const cfg = loadConfig()
    const ws = findWorkspace(cfg, (request.query as { workspace?: string }).workspace ?? '')
    if (!ws) {
      reply.code(400).send({ error: 'unknown workspace' })
      return
    }
    let session: ChatSession
    try {
      session = await getSession(ws, false)
    } catch (err) {
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
      return
    }
    reply.send({ commands: await session.commands() })
  })
}