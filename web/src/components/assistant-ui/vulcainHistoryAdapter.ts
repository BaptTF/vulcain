import type {
  GenericThreadHistoryAdapter,
  MessageFormatAdapter,
  MessageFormatItem,
  MessageFormatRepository,
  ThreadHistoryAdapter
} from '@assistant-ui/react'
import { getChatMessages, putChatMessages, type ChatMessageRepo } from '../../api'

type GetAui = () => { threadListItem?: { getState?: () => { remoteId?: string | null } } }

class VulcainFormattedHistoryAdapter<TMessage> implements GenericThreadHistoryAdapter<TMessage> {
  constructor(
    private readonly ws: string,
    private readonly getAui: GetAui,
    private readonly format: MessageFormatAdapter<TMessage, Record<string, unknown>>
  ) {}

  private remoteId(): string | null {
    try {
      return this.getAui()?.threadListItem?.getState?.()?.remoteId ?? null
    } catch {
      return null
    }
  }

  private async readRepo(id: string): Promise<ChatMessageRepo> {
    try {
      const repo = await getChatMessages(this.ws, id)
      if (repo && Array.isArray(repo.messages)) return repo
    } catch {}
    return { messages: [] }
  }

  private toEntry(item: MessageFormatItem<TMessage>) {
    return {
      id: this.format.getId(item.message),
      parent_id: item.parentId,
      format: this.format.format,
      content: this.format.encode(item)
    }
  }

  async load(): Promise<MessageFormatRepository<TMessage>> {
    const id = this.remoteId()
    if (!id) return { messages: [] }
    const repo = await this.readRepo(id)
    return { headId: repo.headId, messages: repo.messages.map(entry => this.format.decode(entry)) }
  }

  async append(item: MessageFormatItem<TMessage>): Promise<void> {
    const id = this.remoteId()
    if (!id) return
    const repo = await this.readRepo(id)
    repo.messages.push(this.toEntry(item))
    repo.headId = this.format.getId(item.message)
    await putChatMessages(this.ws, id, repo)
  }

  async update(item: MessageFormatItem<TMessage>, localMessageId?: string): Promise<void> {
    const id = this.remoteId()
    if (!id) return
    const repo = await this.readRepo(id)
    const entryId = localMessageId ?? this.format.getId(item.message)
    const idx = repo.messages.findIndex(m => m.id === entryId)
    if (idx >= 0) repo.messages[idx] = this.toEntry(item)
    else repo.messages.push(this.toEntry(item))
    repo.headId = entryId
    await putChatMessages(this.ws, id, repo)
  }

  async delete(items: MessageFormatItem<TMessage>[]): Promise<void> {
    const id = this.remoteId()
    if (!id) return
    const repo = await this.readRepo(id)
    const ids = new Set(items.map(item => this.format.getId(item.message)))
    repo.messages = repo.messages.filter(m => !ids.has(m.id))
    await putChatMessages(this.ws, id, repo)
  }

  pin(): void {}

  reportTelemetry(): void {}
}

/**
 * Persists chat history on the server (`.sessions/<id>/ui.json`) in the AI SDK
 * message format. Implements `withFormat` which `useChatRuntime` requires.
 */
export class VulcainHistoryAdapter implements ThreadHistoryAdapter {
  constructor(
    private readonly ws: string,
    private readonly getAui: GetAui
  ) {}

  withFormat<TMessage, TStorageFormat extends Record<string, unknown>>(
    formatAdapter: MessageFormatAdapter<TMessage, TStorageFormat>
  ): GenericThreadHistoryAdapter<TMessage> {
    return new VulcainFormattedHistoryAdapter(
      this.ws,
      this.getAui,
      formatAdapter as MessageFormatAdapter<TMessage, Record<string, unknown>>
    ) as GenericThreadHistoryAdapter<TMessage>
  }

  async load() {
    return { messages: [] }
  }

  async append() {}
}
