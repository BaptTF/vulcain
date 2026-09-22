import { createContext, forwardRef, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ActionBarPrimitive,
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadListPrimitive,
  ThreadListItemPrimitive,
  ThreadPrimitive,
  groupPartByType,
  useAui,
  useAuiState
} from '@assistant-ui/react'
import { useThreadTokenUsage } from '@assistant-ui/ai-sdk'
import { abortChat } from '../../api'
import { confirmDelete } from '../../confirmDelete'
import { renderMarkdown } from '../../markdown'

const GROUP = groupPartByType({
  reasoning: ['group-chainOfThought', 'group-reasoning'],
  'tool-call': ['group-chainOfThought', 'group-tool'],
  'standalone-tool-call': []
})

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

function toolTitle(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const record = args as Record<string, unknown>
  if (typeof record.path === 'string') return `${toolName} ${record.path}`
  if (typeof record.command === 'string') return `${toolName} ${record.command.slice(0, 60)}`
  if (typeof record.query === 'string') return `${toolName} "${record.query.slice(0, 60)}"`
  return undefined
}

const OpenFileContext = createContext<(path: string) => void>(() => {})
const AT_BOTTOM_THRESHOLD = 8
const ESTIMATED_TURN_HEIGHT = 200

type MessageRow = { id: string; role: string }
type Turn = { id: string; messageIds: string[] }

function buildTurns(messages: readonly MessageRow[]): Turn[] {
  if (messages.length === 0) return []
  const turns: Turn[] = []
  for (const { id, role } of messages) {
    const last = turns.at(-1)
    if (role === 'user' || !last) turns.push({ id, messageIds: [id] })
    else last.messageIds.push(id)
  }
  return turns
}

function useThreadMessageRows(): readonly MessageRow[] {
  const prevRef = useRef<readonly MessageRow[]>([])
  return useAuiState((s: any) => {
    const messages = s.thread.messages as { id: string; role: string }[]
    const prev = prevRef.current
    if (
      prev.length === messages.length &&
      prev.every((row, i) => row.id === messages[i]?.id && row.role === messages[i]?.role)
    ) {
      return prev
    }
    const next = messages.map(({ id, role }) => ({ id, role }))
    prevRef.current = next
    return next
  })
}

function AuiUserMessage(): ReactNode {
  return (
    <MessagePrimitive.Root className="aui-msg aui-msg-user" data-role="user">
      <div className="aui-user-bubble">
        <MessagePrimitive.Parts />
      </div>
      <div className="aui-message-footer">
        <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="aui-action-bar">
          <ActionBarPrimitive.Edit asChild>
            <button type="button" className="icon-btn" title="Modifier">
              ✎
            </button>
          </ActionBarPrimitive.Edit>
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  )
}

function AuiAssistantMessage(): ReactNode {
  const onOpenFile = useContext(OpenFileContext)
  return (
    <MessagePrimitive.Root className="aui-msg aui-msg-assistant" data-role="assistant">
      <div className="aui-msg-parts">
        <MessagePrimitive.GroupedParts groupBy={GROUP}>
          {({ part, children }: any) => {
            switch (part.type) {
              case 'group-chainOfThought':
                return <div className="aui-chain">{children}</div>
              case 'group-tool':
                return <div className="aui-tool-group">{children}</div>
              case 'group-reasoning':
                return <AuiReasoningGroup>{children}</AuiReasoningGroup>
              case 'text':
                return <MessagePartPrimitive.Text component={AuiMarkdown as any} />
              case 'reasoning':
                return <AuiReasoningText />
              case 'tool-call':
                return part.toolUI ?? <AuiToolCard part={part} onOpenFile={onOpenFile} />
              case 'indicator':
                return (
                  <span className="aui-indicator" aria-label="Agent en cours">
                    ●
                  </span>
                )
              default:
                return null
            }
          }}
        </MessagePrimitive.GroupedParts>
      </div>
      <div className="aui-message-footer">
        <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="aui-action-bar">
          <ActionBarPrimitive.Copy asChild>
            <button type="button" className="icon-btn" title="Copier">
              ⧉
            </button>
          </ActionBarPrimitive.Copy>
          <ActionBarPrimitive.Reload asChild>
            <button type="button" className="icon-btn" title="Régénérer">
              ⟳
            </button>
          </ActionBarPrimitive.Reload>
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  )
}

function AuiEditComposer(): ReactNode {
  return (
    <MessagePrimitive.Root className="aui-msg aui-edit">
      <ComposerPrimitive.Root className="aui-composer">
        <ComposerPrimitive.Input asChild autoFocus>
          <textarea className="aui-composer-input" rows={3} />
        </ComposerPrimitive.Input>
        <div className="aui-composer-actions">
          <ComposerPrimitive.Cancel asChild>
            <button type="button" className="btn">
              Annuler
            </button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <button type="button" className="btn primary">
              Mettre à jour
            </button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  )
}

const MESSAGE_COMPONENTS = {
  UserMessage: AuiUserMessage,
  AssistantMessage: AuiAssistantMessage,
  EditComposer: AuiEditComposer
}

export function AuiThread({
  onOpenFile,
  ws,
  visible
}: {
  onOpenFile: (path: string) => void
  ws: string
  visible: boolean
}): ReactNode {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const threadId = useAuiState((s: any) => s.threadListItem?.id)
  const isRunning = useAuiState((s: any) => s.thread.isRunning)
  const rows = useThreadMessageRows()
  const turns = useMemo(() => buildTurns(rows), [rows])

  const virtualizer = useVirtualizer({
    count: turns.length,
    estimateSize: () => ESTIMATED_TURN_HEIGHT,
    getItemKey: index => turns[index]?.id ?? index,
    getScrollElement: () => scrollerRef.current,
    overscan: 6,
    scrollToFn: (offset, _options, instance) => {
      const el = instance.scrollElement as HTMLElement | null
      if (!el) return
      if (stickyRef.current) {
        const maxScroll = el.scrollHeight - el.clientHeight
        if (maxScroll - el.scrollTop <= AT_BOTTOM_THRESHOLD && offset < maxScroll) return
      }
      el.scrollTo(0, offset)
    }
  })

  const jumpBottom = useCallback(() => {
    stickyRef.current = true
    setAtBottom(true)
    if (turns.length > 0) virtualizer.scrollToIndex(turns.length - 1, { align: 'end' })
    requestAnimationFrame(() => {
      const el = scrollerRef.current
      if (el && stickyRef.current) el.scrollTop = el.scrollHeight
    })
  }, [turns.length, virtualizer])
  const jumpBottomRef = useRef(jumpBottom)
  jumpBottomRef.current = jumpBottom

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    let lastScrollTop = el.scrollTop
    let lastScrollHeight = el.scrollHeight
    let lastClientHeight = el.clientHeight
    const onScroll = () => {
      const next = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD
      if (next) stickyRef.current = true
      else if (
        el.scrollTop < lastScrollTop &&
        el.scrollHeight === lastScrollHeight &&
        Math.abs(el.clientHeight - lastClientHeight) <= 1
      ) {
        stickyRef.current = false
      }
      lastScrollTop = el.scrollTop
      lastScrollHeight = el.scrollHeight
      lastClientHeight = el.clientHeight
      setAtBottom(prev => (prev === next ? prev : next))
    }
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) stickyRef.current = false
    }
    const onTouchMove = () => {
      stickyRef.current = false
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchmove', onTouchMove)
    }
  }, [])

  useEffect(() => {
    if (!visible) return
    const el = scrollerRef.current
    const content = contentRef.current
    if (!el || !content) return
    const observer = new ResizeObserver(() => {
      if (stickyRef.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [visible])

  const prevRunning = useRef(false)
  useLayoutEffect(() => {
    if (isRunning && !prevRunning.current) jumpBottomRef.current()
    prevRunning.current = isRunning
  }, [isRunning])

  useLayoutEffect(() => {
    if (!visible) return
    stickyRef.current = true
    setAtBottom(true)
    virtualizer.measure()
    jumpBottomRef.current()
  }, [visible, threadId])

  const items = virtualizer.getVirtualItems()
  const paddingTop = items[0]?.start ?? 0
  const paddingBottom = Math.max(0, virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0))

  return (
    <OpenFileContext.Provider value={onOpenFile}>
      <ThreadPrimitive.Root className="aui-thread">
        <div className="aui-viewport" ref={scrollerRef}>
          <div className="aui-messages" ref={contentRef}>
            <div style={{ paddingTop, paddingBottom }}>
              {items.map(item => (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="aui-turn"
                >
                  {turns[item.index]?.messageIds.map(messageId => (
                    <ThreadPrimitive.Unstable_MessageById
                      key={messageId}
                      messageId={messageId}
                      components={MESSAGE_COMPONENTS}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="aui-thread-footer">
          <AuiComposer ws={ws} />
          {!atBottom ? (
            <button className="aui-scroll-bottom" type="button" aria-label="Descendre en bas" onClick={jumpBottom}>
              ↓
            </button>
          ) : null}
        </div>
      </ThreadPrimitive.Root>
    </OpenFileContext.Provider>
  )
}

const AuiMarkdown = memo(function AuiMarkdown({ children }: { children?: ReactNode }): ReactNode {
  const text = typeof children === 'string' ? children : ''
  const html = useMemo(() => (text ? renderMarkdown(text) : ''), [text])
  return <div className="md-body aui-markdown" dangerouslySetInnerHTML={{ __html: html }} />
})

function AuiReasoningText(): ReactNode {
  const text = useAuiState((s: any) => (s.part?.type === 'reasoning' ? s.part.text : ''))
  if (!text) return null
  return (
    <div className="aui-reasoning-body">
      <MessagePartPrimitive.Text component={AuiMarkdown as any} />
    </div>
  )
}

function AuiReasoningGroup({ children }: { children: ReactNode }): ReactNode {
  return (
    <details className="aui-reasoning">
      <summary className="aui-reasoning-summary">Réflexion</summary>
      <div className="aui-reasoning-body">{children}</div>
    </details>
  )
}

type AuiToolPart = {
  toolName?: string
  args?: unknown
  result?: unknown
  isError?: boolean
  status?: { type?: string }
}

function AuiToolCard({ part, onOpenFile }: { part: AuiToolPart; onOpenFile: (path: string) => void }): ReactNode {
  const { toolName = 'outil', args, result, isError, status } = part
  const [expanded, setExpanded] = useState(false)
  const title = toolTitle(toolName, args) ?? toolName
  const kind = KIND_BY_TOOL[toolName] ?? 'other'
  const running = status?.type === 'running'
  const path = args && typeof args === 'object' ? (args as Record<string, unknown>).path : undefined

  const resultText = typeof result === 'string' ? result : result ? JSON.stringify(result) : ''

  return (
    <div className={`tool-card${running ? ' running' : ''}`}>
      <div className="tool-card-header" onClick={() => setExpanded(e => !e)}>
        <span className="tool-kind">{kind}</span>
        <span className="tool-card-title">{title}</span>
        <span className={`tool-status ${running ? 'in_progress' : isError ? 'failed' : 'completed'}`}>
          {running ? 'en cours' : isError ? 'erreur' : 'terminé'}
        </span>
      </div>
      {typeof path === 'string' && (
        <div className="tool-card-location">
          <a
            href="#"
            onClick={e => {
              e.preventDefault()
              onOpenFile(path as string)
            }}
          >
            {path}
          </a>
        </div>
      )}
      {(expanded || running) && (
        <div className="tool-detail">
          {args !== undefined && <pre className="tool-args">{JSON.stringify(args, null, 2)}</pre>}
          {resultText && <pre className="tool-result">{resultText}</pre>}
        </div>
      )}
    </div>
  )
}

function AuiComposer({ ws }: { ws: string }): ReactNode {
  const isRunning = useAuiState((s: any) => s.thread.isRunning)
  const remoteId = useAuiState((s: any) => s.threadListItem?.id ?? s.threadListItem?.remoteId)
  return (
    <ComposerPrimitive.Root className="aui-composer">
      <ComposerPrimitive.Input asChild autoFocus={false}>
        <textarea
          className="aui-composer-input"
          placeholder="Écrivez à l'agent… (Entrée pour envoyer)"
          rows={2}
        />
      </ComposerPrimitive.Input>
      <div className="aui-composer-actions">
        {isRunning ? (
          <ComposerPrimitive.Cancel asChild>
            <button type="button" className="btn danger" onClick={() => void abortChat(ws, remoteId)}>
              Stop
            </button>
          </ComposerPrimitive.Cancel>
        ) : (
          <ComposerPrimitive.Send asChild>
            <button type="button" className="btn primary">
              Envoyer
            </button>
          </ComposerPrimitive.Send>
        )}
      </div>
    </ComposerPrimitive.Root>
  )
}

const SessionsPanelContext = createContext<(() => void) | undefined>(undefined)
const DeleteSessionContext = createContext<((id: string) => void) | null>(null)
const SESSION_ITEM_COMPONENTS = { ThreadListItem: AuiSessionItem }

export function SessionDeleteProvider({
  children,
  onBeforeDelete
}: {
  children: ReactNode
  onBeforeDelete?: () => void
}): ReactNode {
  const aui = useAui()
  const deleteSession = useCallback(
    (id: string) => {
      onBeforeDelete?.()
      aui.threads.item({ id }).delete()
    },
    [aui, onBeforeDelete]
  )
  return <DeleteSessionContext.Provider value={deleteSession}>{children}</DeleteSessionContext.Provider>
}

export const AuiSessionsPanel = forwardRef<HTMLDivElement, { onSelect?: () => void }>(
  function AuiSessionsPanel({ onSelect }, ref): ReactNode {
    return (
      <SessionsPanelContext.Provider value={onSelect}>
        <div className="aui-sessions" ref={ref}>
          <ThreadListPrimitive.Root className="aui-sessions-list">
            <ThreadListPrimitive.Items components={SESSION_ITEM_COMPONENTS} />
            <ThreadListPrimitive.New asChild>
              <button type="button" className="btn" onClick={() => onSelect?.()}>
                Nouvelle session
              </button>
            </ThreadListPrimitive.New>
          </ThreadListPrimitive.Root>
        </div>
      </SessionsPanelContext.Provider>
    )
  }
)

function AuiSessionItem(): ReactNode {
  const onSelect = useContext(SessionsPanelContext)
  const deleteSession = useContext(DeleteSessionContext)
  const itemId = useAuiState((s: any) => s.threadListItem?.id)
  const title = useAuiState((s: any) => s.threadListItem?.title) as string | undefined
  return (
    <ThreadListItemPrimitive.Root className="aui-session-item">
      <ThreadListItemPrimitive.Trigger asChild>
        <button type="button" className="aui-session-trigger" onClick={() => onSelect?.()}>
          <span className="aui-session-title">
            <ThreadListItemPrimitive.Title fallback="Nouvelle session" />
          </span>
        </button>
      </ThreadListItemPrimitive.Trigger>
      <button
        type="button"
        className="icon-btn aui-session-delete"
        title="Supprimer"
        onPointerDown={e => e.stopPropagation()}
        onClick={e => {
          e.preventDefault()
          e.stopPropagation()
          const id = itemId
          if (!id || !deleteSession) return
          confirmDelete(title?.trim() || 'cette session', async () => {
            deleteSession(id)
          })
        }}
      >
        ✕
      </button>
    </ThreadListItemPrimitive.Root>
  )
}

export function AuiUsageBar(): ReactNode {
  const tokens = useThreadTokenUsage()
  const contextUsage = useAuiState((s: any) => {
    const msgs = s.thread.messages
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const cu = msgs[i]?.metadata?.custom?.contextUsage
      if (cu) return cu
    }
    return undefined
  })
  if (!contextUsage || contextUsage.contextWindow <= 0) return null
  const percent =
    typeof contextUsage.percent === 'number'
      ? contextUsage.percent
      : contextUsage.tokens && contextUsage.contextWindow
        ? (contextUsage.tokens / contextUsage.contextWindow) * 100
        : 0
  const percentLabel = percent.toFixed(2)
  const warn = percent >= 70
  return (
    <div className={`aui-usage${warn ? ' warn' : ''}`} title={`${percentLabel}% du contexte utilisé`}>
      <div className="aui-usage-track">
        <div className="aui-usage-fill" style={{ width: `${Math.min(100, percent)}%` }} />
      </div>
      <span className="aui-usage-label">
        {percentLabel}%{tokens?.totalTokens != null ? ` · ${tokens.totalTokens} tok` : ''}
      </span>
    </div>
  )
}