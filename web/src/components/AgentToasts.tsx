import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { subscribeChatEvents } from '../api'

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
    return subscribeChatEvents(msg => {
      const view = viewRef.current
      if (msg.workspace === view.activeWs && msg.sessionId === view.activeSessionId) return
      toast.success('Réponse prête', {
        description: msg.title || msg.workspace,
        duration: 12000,
        action: {
          label: 'Ouvrir',
          onClick: () => onOpenRef.current(msg.workspace, msg.sessionId)
        }
      })
    })
  }, [])

  return null
}
