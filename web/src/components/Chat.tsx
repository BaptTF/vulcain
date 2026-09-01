import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AssistantRuntimeProvider, useAui, useAuiState, useRemoteThreadListRuntime } from '@assistant-ui/react'
import { createLocalStorageAdapter, createSimpleTitleAdapter } from '@assistant-ui/core/react'
import { AssistantChatTransport, useAISDKError, useChatRuntime } from '@assistant-ui/ai-sdk'
import { AuiSessionsPanel, AuiThread, AuiUsageBar } from './assistant-ui/AuiElements'
import { VulcainHistoryAdapter } from './assistant-ui/vulcainHistoryAdapter'

interface Props {
  ws: string
  onOpenFile: (path: string) => void
}

const asyncStorage = {
  getItem: (k: string) => Promise.resolve(localStorage.getItem(k)),
  setItem: (k: string, v: string) => Promise.resolve(localStorage.setItem(k, v)),
  removeItem: (k: string) => Promise.resolve(localStorage.removeItem(k))
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
      Agent
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

export default function Chat({ ws, onOpenFile }: Props): React.ReactNode {
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>(
    () => localStorage.getItem(`vulcain.chat.active.${ws}`) ?? undefined
  )
  const sessionsRef = useRef<HTMLDivElement>(null)
  const sessionsBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!sessionsOpen) return
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Element | null
      if (!target) return
      if (sessionsRef.current?.contains(target)) return
      if (sessionsBtnRef.current?.contains(target)) return
      setSessionsOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSessionsOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [sessionsOpen])

  const adapter = useMemo(
    () =>
      createLocalStorageAdapter({
        storage: asyncStorage,
        prefix: `vulcain.chat.${ws}.`,
        titleGenerator: createSimpleTitleAdapter()
      }),
    [ws]
  )

  const runtimeHook = useCallback(() => {
    const threadId = useAuiState((s: any) => s.threadListItem?.id)
    const aui = useAui()
    const auiRef = useRef(aui)
    auiRef.current = aui
    const history = useMemo(
      () =>
        new VulcainHistoryAdapter(asyncStorage, `vulcain.chat.${ws}.`, () => auiRef.current),
      [ws]
    )
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
      setActiveThreadId(id)
      if (id) localStorage.setItem(`vulcain.chat.active.${ws}`, id)
    }
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="panel-chat">
        <ChatHeader
          sessionsOpen={sessionsOpen}
          onToggleSessions={() => setSessionsOpen(o => !o)}
          sessionsBtnRef={sessionsBtnRef}
        />
        {sessionsOpen && <AuiSessionsPanel ref={sessionsRef} onSelect={() => setSessionsOpen(false)} />}
        <AuiThread onOpenFile={onOpenFile} />
      </div>
    </AssistantRuntimeProvider>
  )
}