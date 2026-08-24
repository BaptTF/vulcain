export interface TextContent {
  type: 'text'
  text: string
}

export type ContentBlock = TextContent

export interface ToolCallLocation {
  path: string
  line?: number
}

export type ToolCallContent =
  | { type: 'content'; content: ContentBlock }
  | { type: 'diff'; path: string; oldText?: string | null; newText?: string | null }
  | { type: 'terminal'; terminalId: string }

export interface ToolCallFields {
  toolCallId: string
  title?: string
  kind?: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'think' | 'fetch' | 'other'
  status?: 'pending' | 'in_progress' | 'completed' | 'failed'
  content?: ToolCallContent[]
  locations?: ToolCallLocation[]
  rawInput?: unknown
  rawOutput?: unknown
}

export type SessionUpdate =
  | ({ sessionUpdate: 'agent_message_chunk' | 'user_message_chunk' } & { content: ContentBlock })
  | ({ sessionUpdate: 'tool_call' } & ToolCallFields)
  | ({ sessionUpdate: 'tool_call_update' } & ToolCallFields)
  | { sessionUpdate: 'plan'; entries: unknown[] }
  | { sessionUpdate: 'available_commands_update'; commands: { name: string; description: string }[] }
  | { sessionUpdate: 'current_mode_update'; currentModeId: string }
  | { sessionUpdate: string; [k: string]: unknown }

export interface AuthMethod {
  id: string
  name: string
  description?: string
}

export interface InitializeResult {
  protocolVersion: number
  agentInfo?: { name?: string; version?: string }
  authMethods?: AuthMethod[]
  promptCapabilities?: Record<string, unknown>
}

interface Pending {
  resolve: (v: any) => void
  reject: (e: Error) => void
}

type NotificationHandler = (method: string, params: any) => void

export class AcpClient {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, Pending>()
  private handlers = new Set<NotificationHandler>()
  private requestHandler: ((method: string, params: any) => Promise<unknown>) | null = null

  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ws.onmessage = ev => {
      if (typeof ev.data !== 'string') return
      let msg: unknown
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      this.dispatch(msg)
    }
  }

  waitOpen(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve()
      this.ws.addEventListener('open', () => resolve(), { once: true })
      this.ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true })
    })
  }

  onNotification(fn: NotificationHandler): void {
    this.handlers.add(fn)
  }

  onRequest(fn: (method: string, params: any) => Promise<unknown>): void {
    this.requestHandler = fn
  }

  private dispatch(msg: any): void {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
      else p.resolve(msg.result)
      return
    }
    if (msg.method !== undefined) {
      if (msg.id !== undefined && this.requestHandler) {
        Promise.resolve()
          .then(() => this.requestHandler!(msg.method, msg.params))
          .then(
            result => this.sendRaw({ jsonrpc: '2.0', id: msg.id, result }),
            err => this.sendRaw({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(err.message ?? err) } })
          )
        return
      }
      for (const h of this.handlers) h(msg.method, msg.params)
    }
  }

  private sendRaw(obj: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj))
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.sendRaw({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.sendRaw({ jsonrpc: '2.0', method, params })
  }

  initialize(): Promise<InitializeResult> {
    return this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {}
    })
  }

  newSession(cwd: string): Promise<{ sessionId: string }> {
    return this.request('session/new', { cwd, mcpServers: [] })
  }

  loadSession(cwd: string, sessionId: string): Promise<{ sessionId: string }> {
    return this.request('session/load', { cwd, sessionId, mcpServers: [] })
  }

  prompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    return this.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }]
    })
  }

  cancel(sessionId: string): void {
    this.notify('session/cancel', { sessionId })
  }

  close(): void {
    try {
      this.ws.close(1000)
    } catch {}
  }
}
