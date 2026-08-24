import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AcpClient,
  type InitializeResult,
  type SessionUpdate,
  type ToolCallContent
} from '../acp'

type Item =
  | { kind: 'user'; id: number; text: string }
  | { kind: 'assistant'; id: number; text: string }
  | { kind: 'system'; id: number; text: string }
  | {
      kind: 'tool'
      id: number
      toolCallId: string
      title: string
      kindLabel?: string
      status?: string
      content?: ToolCallContent[]
      locations?: { path: string; line?: number }[]
    }

interface Props {
  ws: string
  onOpenFile: (path: string) => void
}

let itemId = 1

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

export default function Chat({ ws, onOpenFile }: Props) {
  const [client, setClient] = useState<AcpClient | null>(null)
  const [status, setStatus] = useState<'connecting' | 'ready' | 'working' | 'error'>('connecting')
  const [items, setItems] = useState<Item[]>([])
  const [input, setInput] = useState('')
  const [commands, setCommands] = useState<{ name: string; description: string }[]>([])
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({})
  const sessionIdRef = useRef<string | null>(null)
  const lastUserText = useRef('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const workingRef = useRef(false)

  const storageKey = `vulcain.chat.${ws}`

  const pushItem = useCallback((item: DistributiveOmit<Item, 'id'> & { id?: number }) => {
    setItems(prev => [...prev, { ...(item as any), id: item.id ?? itemId++ }])
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [items])

  const applyUpdate = useCallback(
    (u: SessionUpdate) => {
      const variant = u.sessionUpdate as string
      if (variant === 'agent_message_chunk') {
        const text = (u as any).content?.text ?? ''
        setItems(prev => {
          const last = prev[prev.length - 1]
          if (last && last.kind === 'assistant') {
            const copy = [...prev.slice(0, -1), { ...last, text: last.text + text }]
            return copy
          }
          return [...prev, { kind: 'assistant', id: itemId++, text }]
        })
        return
      }
      if (variant === 'user_message_chunk') {
        const text = (u as any).content?.text ?? ''
        if (text === lastUserText.current) return
        setItems(prev => [...prev, { kind: 'user', id: itemId++, text }])
        return
      }
      if (variant === 'tool_call' || variant === 'tool_call_update') {
        const fields: any = u
        setItems(prev => {
          const idx = prev.findIndex(it => it.kind === 'tool' && it.toolCallId === fields.toolCallId)
          if (idx >= 0) {
            const old = prev[idx] as Extract<Item, { kind: 'tool' }>
            const merged: Item = {
              ...old,
              title: fields.title ?? old.title,
              kindLabel: fields.kind ?? old.kindLabel,
              status: fields.status ?? old.status,
              content: fields.content ?? old.content,
              locations: fields.locations ?? old.locations
            }
            return [...prev.slice(0, idx), merged, ...prev.slice(idx + 1)]
          }
          return [
            ...prev,
            {
              kind: 'tool',
              id: itemId++,
              toolCallId: fields.toolCallId,
              title: fields.title ?? fields.toolCallId,
              kindLabel: fields.kind,
              status: fields.status,
              content: fields.content,
              locations: fields.locations
            }
          ]
        })
        return
      }
      if (variant === 'available_commands_update') {
        setCommands((u as any).commands ?? [])
        return
      }
    },
    []
  )

  useEffect(() => {
    setStatus('connecting')
    setItems([])
    setCommands([])
    let disposed = false
    let currentClient: AcpClient | null = null

    async function connect(): Promise<void> {
      sessionIdRef.current = localStorage.getItem(storageKey)
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
      const c = new AcpClient(`${protocol}://${location.host}/api/acp?ws=${encodeURIComponent(ws)}`)
      currentClient = c

      c.onNotification((method, params) => {
        if (method === 'session/update') applyUpdate(params.update)
      })

      c.onRequest(async (method, params) => {
        if (method === 'session/request_permission') {
          const options: any[] = params?.options ?? []
          const allow = options.find(o => String(o.kind).startsWith('allow')) ?? options[0]
          if (!allow) throw new Error('no permission option')
          return { outcome: { outcome: 'selected', optionId: allow.optionId } }
        }
        throw new Error(`unsupported request: ${method}`)
      })

      try {
        await c.waitOpen()
        const init: InitializeResult = await c.initialize()
        if (init.agentInfo?.name) {
          pushItem({
            kind: 'system',
            text: `${init.agentInfo.name}${init.agentInfo.version ? ' v' + init.agentInfo.version : ''}`
          })
        }
        const cwd = '.'
        let sessionId = sessionIdRef.current
        if (sessionId) {
          try {
            await c.loadSession(cwd, sessionId)
          } catch {
            sessionId = null
            localStorage.removeItem(storageKey)
          }
        }
        if (!sessionId) {
          const res = await c.newSession(cwd)
          sessionId = res.sessionId
          sessionIdRef.current = sessionId
          localStorage.setItem(storageKey, sessionId)
        }
        if (disposed) {
          c.close()
          return
        }
        setClient(c)
        setStatus('ready')
      } catch (e: any) {
        if (disposed) return
        setStatus('error')
        pushItem({ kind: 'system', text: `Connexion à l'agent impossible : ${e.message}` })
      }
    }

    connect()

    return () => {
      disposed = true
      currentClient?.close()
      setClient(null)
    }
  }, [ws, storageKey, applyUpdate, pushItem])

  const send = useCallback(async () => {
    if (!client || !sessionIdRef.current || workingRef.current) return
    const text = input.trim()
    if (!text) return
    setInput('')
    lastUserText.current = text
    pushItem({ kind: 'user', text })
    workingRef.current = true
    setStatus('working')
    try {
      await client.prompt(sessionIdRef.current, text)
    } catch (e: any) {
      pushItem({ kind: 'system', text: `Erreur : ${e.message}` })
    } finally {
      workingRef.current = false
      setStatus('ready')
    }
  }, [client, input, pushItem])

  const cancel = useCallback(() => {
    if (client && sessionIdRef.current) {
      client.cancel(sessionIdRef.current)
    }
  }, [client])

  const newChat = useCallback(async () => {
    if (!client) return
    localStorage.removeItem(storageKey)
    sessionIdRef.current = null
    setItems([])
    try {
      const res = await client.newSession('.')
      sessionIdRef.current = res.sessionId
      localStorage.setItem(storageKey, res.sessionId)
      setStatus(workingRef.current ? 'working' : 'ready')
    } catch (e: any) {
      pushItem({ kind: 'system', text: `Nouvelle session impossible : ${e.message}` })
    }
  }, [client, storageKey, pushItem])

  const hints = input.startsWith('/')
    ? commands.filter(cmd => cmd.name.startsWith(input.slice(1).split(' ')[0]))
    : []

  const statusLabel =
    status === 'connecting' ? 'connexion…' : status === 'ready' ? 'prêt' : status === 'working' ? 'en cours…' : 'erreur'

  return (
    <div className="panel-chat">
      <div className="chat-header">
        Agent
        <span className={`chat-status ${status}`}>{statusLabel}</span>
        <div className="spacer" />
        <button className="btn" onClick={newChat} disabled={!client}>
          Nouvelle session
        </button>
      </div>
      <div className="chat-messages">
        {items.map(item => (
          <MessageView
            key={item.id}
            item={item}
            expanded={expandedTools[item.kind === 'tool' ? item.toolCallId : '']}
            toggleExpand={() =>
              setExpandedTools(e => ({
                ...e,
                [item.kind === 'tool' ? item.toolCallId : '']: !e[item.kind === 'tool' ? item.toolCallId : '']
              }))
            }
            onOpenFile={onOpenFile}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>
      <div className="chat-input-area">
        {hints.length > 0 && (
          <div className="chat-hints">
            {hints.slice(0, 8).map(cmd => (
              <span
                key={cmd.name}
                className="chat-hint"
                title={cmd.description}
                onClick={() => setInput(`/${cmd.name} `)}
              >
                /{cmd.name}
              </span>
            ))}
          </div>
        )}
        <div className="chat-input-row">
          <textarea
            className="chat-input"
            placeholder="Écrivez à l'agent… (Entrée pour envoyer)"
            value={input}
            rows={2}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
          {status === 'working' ? (
            <button className="btn danger" onClick={cancel}>
              Stop
            </button>
          ) : (
            <button className="btn primary" onClick={() => void send()} disabled={!client || !input.trim()}>
              Envoyer
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function MessageView({
  item,
  expanded,
  toggleExpand,
  onOpenFile
}: {
  item: Item
  expanded: boolean
  toggleExpand: () => void
  onOpenFile: (p: string) => void
}) {
  if (item.kind === 'user') {
    return <div className="msg user">{item.text}</div>
  }
  if (item.kind === 'system') {
    return <div className="msg system">{item.text}</div>
  }
  if (item.kind === 'assistant') {
    return (
      <div className="msg assistant">
        <LiteMarkdown text={item.text} />
      </div>
    )
  }
  const hasDetail = (item.content?.length ?? 0) > 0
  return (
    <div className="tool-card">
      <div className="tool-card-header" onClick={hasDetail ? toggleExpand : undefined}>
        <span className="tool-kind">{item.kindLabel ?? 'outil'}</span>
        <span>{item.title}</span>
        <span className={`tool-status ${item.status ?? ''}`}>{item.status}</span>
      </div>
      {item.locations && item.locations.length > 0 && (
        <div style={{ padding: '0 10px 6px' }}>
          {item.locations.map((loc, i) => (
            <a
              key={i}
              href="#"
              style={{ color: 'var(--hl-link)', fontSize: 12 }}
              onClick={e => {
                e.preventDefault()
                onOpenFile(loc.path)
              }}
            >
              {loc.path}
              {loc.line ? `:${loc.line}` : ''}
            </a>
          ))}
        </div>
      )}
      {expanded && hasDetail && (
        <div className="tool-detail">
          {item.content!.map((block, i) => (
            <ToolContentBlock key={i} block={block} />
          ))}
        </div>
      )}
    </div>
  )
}

function ToolContentBlock({ block }: { block: ToolCallContent }) {
  if (block.type === 'diff') {
    const del = (block.oldText ?? '').split('\n')
    const add = (block.newText ?? '').split('\n')
    return (
      <>
        {del.map((l, i) => (
          <span key={`d${i}`} className="diff-del">
            {l || ' '}
          </span>
        ))}
        {add.map((l, i) => (
          <span key={`a${i}`} className="diff-add">
            {l || ' '}
          </span>
        ))}
      </>
    )
  }
  if (block.type === 'content') {
    return <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{block.content.text}</pre>
  }
  return <pre>[terminal]</pre>
}

function LiteMarkdown({ text }: { text: string }) {
  const parts: ReactNode[] = []
  const segments = text.split(/```/)
  segments.forEach((seg, i) => {
    if (i % 2 === 1) {
      const nl = seg.indexOf('\n')
      const lang = nl > -1 ? seg.slice(0, nl).trim() : ''
      const code = nl > -1 ? seg.slice(nl + 1) : seg
      parts.push(
        <pre key={i}>
          {lang && <div style={{ color: 'var(--muted)', fontSize: 11 }}>{lang}</div>}
          <code>{code.replace(/\n$/, '')}</code>
        </pre>
      )
    } else if (seg.trim()) {
      parts.push(<Paragraphs key={i} text={seg} />)
    }
  })
  return <>{parts}</>
}

function Paragraphs({ text }: { text: string }) {
  const blocks = text.split(/\n\n+/)
  return (
    <>
      {blocks.map((b, i) => (
        <p key={i}>{inline(b)}</p>
      ))}
    </>
  )
}

function inline(text: string): ReactNode[] {
  const escaped = text.replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[ch]!)
  const tokens = escaped.split(/(`[^`]+`|\*\*[^*]+\*\*|_[^_]+_|\[[^\]]+\]\([^)]+\))/g)
  return tokens.map((tok, i) => {
    if (/^`[^`]+`$/.test(tok)) return <code key={i}>{tok.slice(1, -1)}</code>
    if (/^\*\*[^*]+\*\*$/.test(tok)) return <strong key={i}>{tok.slice(2, -2)}</strong>
    if (/^_[^_]+_$/.test(tok)) return <em key={i}>{tok.slice(1, -1)}</em>
    const linkMatch = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
    if (linkMatch) {
      return (
        <a key={i} href={linkMatch[2]} target="_blank" rel="noreferrer">
          {linkMatch[1]}
        </a>
      )
    }
    return <span key={i}>{tok}</span>
  })
}
