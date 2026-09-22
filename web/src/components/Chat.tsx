import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AssistantRuntimeProvider, useAui, useAuiState, useRemoteThreadListRuntime } from '@assistant-ui/react'
import { AssistantChatTransport, useAISDKChat, useAISDKError, useChatRuntime } from '@assistant-ui/ai-sdk'
import { AuiSessionsPanel, AuiThread, AuiUsageBar, SessionDeleteProvider } from './assistant-ui/AuiElements'
import { VulcainHistoryAdapter } from './assistant-ui/vulcainHistoryAdapter'
import { createServerThreadAdapter } from './assistant-ui/serverThreadAdapter'
import { abortChat, getChatMessages, listChatSessions, setActiveChatSession, subscribeChatEvents } from '../api'

interface Props {
  ws: string
  visible: boolean
  focusSessionId?: string
  onFocusApplied?: () => void
  onActiveThreadChange?: (ws: string, sessionId: string | undefined) => void
  onOpenFile: (path: string) => void
}

function ChatHeader({
  sessionsOpen,
  onToggleSessions,
  sessionsBtnRef
}: {
  sessionsOpen: boolean
  onToggleSessions: () => void
  sessionsBtnRef: React.RefObject<HTMLButtonElement>
}): React.ReactNode {
  const isRunning = useAuiState((s: any) => s.thread.isRunning)
  const error = useAISDKError()
  const activeTitle = useAuiState((s: any) => s.threadListItem?.title)

  const status = isRunning ? 'working' : error ? 'error' : 'ready'
  const statusLabel = isRunning ? 'en cours…' : error ? 'erreur' : 'prêt'
  const label = activeTitle ? `${activeTitle} ▾` : 'Sessions ▾'

  return (
    <div className="chat-header">
      <span className={`chat-status ${status}`}>{statusLabel}</span>
      <AuiUsageBar />
      <div className="spacer" />
      <button
        ref={sessionsBtnRef}
        className={`btn chat-sessions-btn${sessionsOpen ? ' active' : ''}`}
        onClick={onToggleSessions}
        aria-haspopup="true"
        aria-expanded={sessionsOpen}
      >
        {label}
      </button>
    </div>
  )
}

export default function Chat({
  ws,
  visible,
  focusSessionId,
  onFocusApplied,
  onActiveThreadChange,
  onOpenFile
}: Props): React.ReactNode {
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>(undefined)
  const sessionsRef = useRef<HTMLDivElement>(null)
  const sessionsBtnRef = useRef<HTMLButtonElement>(null)
  const restoredIdRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    restoredIdRef.current = null
    listChatSessions(ws)
      .then(list => {
        if (cancelled) return
        if (list.activeId) {
          restoredIdRef.current = list.activeId
          setActiveThreadId(list.activeId)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [ws])

  useEffect(() => {
    if (restoredIdRef.current && activeThreadId === restoredIdRef.current) {
      restoredIdRef.current = null
    }
  }, [activeThreadId])

  useEffect(() => {
    if (!focusSessionId) return
    setActiveThreadId(focusSessionId)
    onFocusApplied?.()
  }, [focusSessionId, onFocusApplied])

  useEffect(() => {
    onActiveThreadChange?.(ws, activeThreadId)
  }, [ws, activeThreadId, onActiveThreadChange])

  useEffect(() => {
    if (!sessionsOpen) return
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Element | null
      if (!target) return
      if (sessionsRef.current?.contains(target)) return
      if (sessionsBtnRef.current?.contains(target)) return
      if (target.closest('[data-sonner-toast]')) return
      setSessionsOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [sessionsOpen])

  const adapter = useMemo(() => createServerThreadAdapter(ws), [ws])

  const runtimeHook = useCallback(() => {
    const threadId = useAuiState((s: any) => s.threadListItem?.id)
    const aui = useAui()
    const auiRef = useRef(aui)
    auiRef.current = aui
    const history = useMemo(() => new VulcainHistoryAdapter(ws, () => auiRef.current), [ws])
    return useChatRuntime({
      id: threadId,
      transport: new AssistantChatTransport({
        api: '/api/chat',
        body: { workspace: ws, sessionId: threadId }
      }),
      adapters: { history }
    })
  }, [ws])

  const runtime = useRemoteThreadListRuntime({
    runtimeHook,
    adapter,
    threadId: activeThreadId ?? undefined,
    onThreadIdChange: (id: string | undefined) => {
      if (restoredIdRef.current && id !== restoredIdRef.current && activeThreadId !== restoredIdRef.current) {
        return
      }
      restoredIdRef.current = null
      setActiveThreadId(id)
      if (id) void setActiveChatSession(ws, id)
    }
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <SessionDeleteProvider onBeforeDelete={() => { restoredIdRef.current = null }}>
        <ChatEscape
          enabled={visible}
          ws={ws}
          sessionsOpen={sessionsOpen}
          onCloseSessions={() => setSessionsOpen(false)}
        />
        <SessionCatchUp ws={ws} />
        <div className="panel-chat" data-testid="agent-chat" hidden={!visible}>
          <ChatHeader
            sessionsOpen={sessionsOpen}
            onToggleSessions={() => setSessionsOpen(o => !o)}
            sessionsBtnRef={sessionsBtnRef}
          />
          {sessionsOpen && <AuiSessionsPanel ref={sessionsRef} onSelect={() => setSessionsOpen(false)} />}
          <AuiThread onOpenFile={onOpenFile} ws={ws} visible={visible} />
        </div>
      </SessionDeleteProvider>
    </AssistantRuntimeProvider>
  )
}

function SessionCatchUp({ ws }: { ws: string }): null {
  const sessionId = useAuiState((s: any) => s.threadListItem?.id ?? s.threadListItem?.remoteId)
  const isRunning = useAuiState((s: any) => s.thread.isRunning)
  const chat = useAISDKChat()
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  const isRunningRef = useRef(isRunning)
  isRunningRef.current = isRunning
  const chatRef = useRef(chat)
  chatRef.current = chat

  useEffect(() => {
    return subscribeChatEvents(msg => {
      if (msg.workspace !== ws || msg.sessionId !== sessionIdRef.current) return
      if (isRunningRef.current) return
      const helpers = chatRef.current
      if (!helpers) return
      void getChatMessages(ws, msg.sessionId)
        .then(repo => {
          if (!repo.messages.length) return
          helpers.setMessages(
            repo.messages.map(entry => ({
              id: entry.id,
              ...entry.content
            })) as never
          )
        })
        .catch(() => {})
    })
  }, [ws])

  return null
}

function ChatEscape({
  enabled,
  ws,
  sessionsOpen,
  onCloseSessions
}: {
  enabled: boolean
  ws: string
  sessionsOpen: boolean
  onCloseSessions: () => void
}): null {
  const isRunning = useAuiState((s: any) => s.thread.isRunning)
  const remoteId = useAuiState((s: any) => s.threadListItem?.id ?? s.threadListItem?.remoteId)
  const aui = useAui()
  const isRunningRef = useRef(isRunning)
  isRunningRef.current = isRunning
  const remoteIdRef = useRef(remoteId)
  remoteIdRef.current = remoteId
  const sessionsOpenRef = useRef(sessionsOpen)
  sessionsOpenRef.current = sessionsOpen
  const onCloseRef = useRef(onCloseSessions)
  onCloseRef.current = onCloseSessions
  const auiRef = useRef(aui)
  auiRef.current = aui
  const wsRef = useRef(ws)
  wsRef.current = ws

  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (sessionsOpenRef.current) {
        onCloseRef.current()
        return
      }
      if (!isRunningRef.current) return
      const target = e.target as HTMLElement | null
      if (target?.closest('.tree-edit-input, .ws-create, .ws-modal, .ws-menu')) return
      e.preventDefault()
      void abortChat(wsRef.current, remoteIdRef.current)
      try {
        auiRef.current.composer.cancel()
      } catch {}
      try {
        auiRef.current.thread.cancelRun()
      } catch {}
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [enabled])

  return null
}
