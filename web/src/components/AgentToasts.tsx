import { useEffect, useRef } from 'react'
import { toast } from 'sonner'

interface Props {
  activeWs: string
  activeSessionId?: string
  onOpen: (workspace: string, sessionId: string) => void
}

export default function AgentToasts({ activeWs, activeSessionId, onOpen }: Props): null {
  const viewRef = useRef({ activeWs, activeSessionId })
  viewRef.current = { activeWs, activeSessionId }
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen

  useEffect(() => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    let socket: WebSocket | undefined
    let retry: number | undefined
    let closed = false

    const connect = () => {
      socket = new WebSocket(`${protocol}://${location.host}/api/chat/events`)
      socket.addEventListener('message', ev => {
        let msg: { type?: string; workspace?: string; sessionId?: string; title?: string }
        try {
          msg = JSON.parse(String(ev.data))
        } catch {
          return
        }
        if (msg.type !== 'session-done' || !msg.workspace || !msg.sessionId) return
        const view = viewRef.current
        if (msg.workspace === view.activeWs && msg.sessionId === view.activeSessionId) return
        toast.success('Réponse prête', {
          description: msg.title || msg.workspace,
          duration: 12000,
          action: {
            label: 'Ouvrir',
            onClick: () => onOpenRef.current(msg.workspace!, msg.sessionId!)
          }
        })
      })
      socket.addEventListener('close', () => {
        if (closed) return
        retry = window.setTimeout(connect, 2000)
      })
    }

    connect()
    return () => {
      closed = true
      if (retry) window.clearTimeout(retry)
      socket?.close()
    }
  }, [])

  return null
}
