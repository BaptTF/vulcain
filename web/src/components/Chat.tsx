import { useCallback, useMemo, useRef, useState } from 'react'
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
  onToggleSessions
}: {
  sessionsOpen: boolean
  onToggleSessions: () => void
}): React.ReactNode {
  const isRunning = useAuiState((s: any) => s.thread.isRunning)
  const error = useAISDKError()

  const status = isRunning ? 'working' : error ? 'error' : 'ready'
  const statusLabel = isRunning ? 'en cours…' : error ? 'erreur' : 'prêt'

  return (
    <div className="chat-header">
      Agent
      <span className={`chat-status ${status}`}>{statusLabel}</span>
      <AuiUsageBar />
      <div className="spacer" />
      <button
        className={`btn${sessionsOpen ? ' active' : ''}`}
        onClick={onToggleSessions}
        aria-expanded={sessionsOpen}
      >
        Sessions
      </button>
    </div>
  )
}

export default function Chat({ ws, onOpenFile }: Props): React.ReactNode {
  const [sessionsOpen, setSessionsOpen] = useState(true)
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>(
    () => localStorage.getItem(`vulcain.chat.active.${ws}`) ?? undefined
  )

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
        <ChatHeader sessionsOpen={sessionsOpen} onToggleSessions={() => setSessionsOpen(o => !o)} />
        <div className="chat-body">
          {sessionsOpen && <AuiSessionsPanel />}
          <AuiThread onOpenFile={onOpenFile} />
        </div>
      </div>
    </AssistantRuntimeProvider>
  )
}