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
  dispatched: boolean
}

type NotificationHandler = (method: string, params: any) => void

export class AcpClient {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, Pending>()
  private handlers = new Set<NotificationHandler>()
  private requestHandler: ((method: string, params: any) => Promise<unknown>) | null = null
  private closeReason: string | null = null
  private onCloseHandlers = new Set<(reason: string, code: number) => void>()

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
    this.ws.onclose = ev => {
      const reason = ev.reason?.trim() || `websocket fermé (${ev.code})`
      this.failAllPending(reason)
      for (const fn of this.onCloseHandlers) fn(reason, ev.code)
    }
    this.ws.onerror = () => {
      this.failAllPending('erreur websocket')
    }
  }

  private failAllPending(reason: string): void {
    if (this.closeReason === null) this.closeReason = reason
    for (const [, p] of this.pending) {
      const err = new Error(this.closeReason) as Error & { dispatched?: boolean }
      err.dispatched = p.dispatched
      p.reject(err)
    }
    this.pending.clear()
  }

  waitOpen(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve()
      if (this.closeReason !== null) return reject(new Error(this.closeReason))
      this.ws.addEventListener('open', () => resolve(), { once: true })
      this.ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true })
      this.ws.addEventListener('close', () => reject(new Error('websocket fermé')), { once: true })
    })
  }

  onClosed(fn: (reason: string, code: number) => void): void {
    this.onCloseHandlers.add(fn)
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

  private sendRaw(obj: unknown): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false
    try {
      this.ws.send(JSON.stringify(obj))
      return true
    } catch {
      return false
    }
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++
    if (this.closeReason !== null || this.ws.readyState >= WebSocket.CLOSING) {
      const err = new Error(this.closeReason ?? 'websocket fermé') as Error & { dispatched?: boolean }
      err.dispatched = false
      return Promise.reject(err)
    }
    return new Promise((resolve, reject) => {
      const p: Pending = { resolve, reject, dispatched: false }
      this.pending.set(id, p)
      p.dispatched = this.sendRaw({ jsonrpc: '2.0', id, method, params })
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
    if (this.closeReason === null) this.closeReason = 'fermé'
    try {
      this.ws.close(1000)
    } catch {}
  }
}
