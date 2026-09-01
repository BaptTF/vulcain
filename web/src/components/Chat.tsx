import { useCallback } from 'react'
import { AssistantRuntimeProvider, useAuiState } from '@assistant-ui/react'
import { AssistantChatTransport, useAISDKChat, useAISDKError, useChatRuntime } from '@assistant-ui/ai-sdk'
import { AuiThread } from './assistant-ui/AuiElements'

interface Props {
  ws: string
  onOpenFile: (path: string) => void
}

function ChatHeader({ ws }: { ws: string }): React.ReactNode {
  const isRunning = useAuiState((s: any) => s.thread.isRunning)
  const error = useAISDKError()
  const chat = useAISDKChat()

  const status = isRunning ? 'working' : error ? 'error' : 'ready'
  const statusLabel = isRunning ? 'en cours…' : error ? 'erreur' : 'prêt'

  const newChat = useCallback(async () => {
    try {
      await fetch('/api/chat/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: ws })
      })
    } catch {}
    chat?.setMessages([])
  }, [ws, chat])

  return (
    <div className="chat-header">
      Agent
      <span className={`chat-status ${status}`}>{statusLabel}</span>
      <div className="spacer" />
      <button className="btn" onClick={() => void newChat()}>
        Nouvelle session
      </button>
    </div>
  )
}

export default function Chat({ ws, onOpenFile }: Props): React.ReactNode {
  const runtime = useChatRuntime({
    transport: new AssistantChatTransport({
      api: '/api/chat',
      body: { workspace: ws }
    })
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="panel-chat">
        <ChatHeader ws={ws} />
        <AuiThread onOpenFile={onOpenFile} />
      </div>
    </AssistantRuntimeProvider>
  )
}