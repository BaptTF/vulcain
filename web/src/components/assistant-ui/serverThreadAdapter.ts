import { createAssistantStream } from 'assistant-stream'
import type { RemoteThreadListAdapter, ThreadMessage } from '@assistant-ui/react'
import { createSimpleTitleAdapter } from '@assistant-ui/core/react'
import {
  deleteChatSession,
  listChatSessions,
  setActiveChatSession,
  upsertChatSession
} from '../../api'

function titleFromMessages(messages: readonly ThreadMessage[]): string {
  const first = messages.find(m => m.role === 'user')
  const textPart = first?.content.find(p => p.type === 'text')
  const text = textPart && textPart.type === 'text' ? textPart.text.trim() : ''
  if (!text) return 'Nouvelle session'
  return text.length > 50 ? `${text.slice(0, 47)}...` : text
}

export function createServerThreadAdapter(ws: string): RemoteThreadListAdapter {
  const titles = createSimpleTitleAdapter()

  return {
    async list() {
      const { sessions } = await listChatSessions(ws)
      return {
        threads: sessions.map(session => ({
          remoteId: session.id,
          status: 'regular' as const,
          title: session.title,
          lastMessageAt: session.modified ? new Date(session.modified) : undefined
        }))
      }
    },

    async initialize(threadId: string) {
      await upsertChatSession(ws, threadId)
      await setActiveChatSession(ws, threadId)
      return { remoteId: threadId, externalId: undefined }
    },

    async rename(remoteId: string, newTitle: string) {
      await upsertChatSession(ws, remoteId, { title: newTitle })
    },

    async archive(remoteId: string) {
      await upsertChatSession(ws, remoteId, { status: 'archived' })
    },

    async unarchive(remoteId: string) {
      await upsertChatSession(ws, remoteId, { status: 'regular' })
    },

    async delete(remoteId: string) {
      await deleteChatSession(ws, remoteId)
    },

    async fetch(threadId: string) {
      const { sessions } = await listChatSessions(ws)
      const session = sessions.find(item => item.id === threadId)
      if (!session) throw new Error(`session "${threadId}" not found`)
      return { remoteId: session.id, status: 'regular' as const, title: session.title }
    },

    async generateTitle(remoteId: string, messages: readonly ThreadMessage[]) {
      const title = (await titles.generateTitle(messages)) || titleFromMessages(messages)
      await upsertChatSession(ws, remoteId, { title })
      return createAssistantStream(controller => {
        controller.appendText(title)
      })
    }
  }
}
