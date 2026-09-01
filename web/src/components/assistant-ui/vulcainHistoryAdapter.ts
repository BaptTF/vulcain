import type {
  GenericThreadHistoryAdapter,
  MessageFormatAdapter,
  MessageFormatItem,
  MessageFormatRepository,
  ThreadHistoryAdapter
} from '@assistant-ui/react'

export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

type GetAui = () => { threadListItem?: { getState?: () => { remoteId?: string | null } } }

interface StoredEntry {
  id: string
  parent_id: string | null
  format: string
  content: Record<string, unknown>
}

interface StoredRepo {
  headId?: string | null
  messages: StoredEntry[]
}

class VulcainFormattedHistoryAdapter<TMessage> implements GenericThreadHistoryAdapter<TMessage> {
  constructor(
    private readonly storage: AsyncStorageLike,
    private readonly prefix: string,
    private readonly getAui: GetAui,
    private readonly format: MessageFormatAdapter<TMessage, Record<string, unknown>>
  ) {}

  private key(): string | null {
    try {
      const remoteId = this.getAui()?.threadListItem?.getState?.()?.remoteId
      return remoteId ? `${this.prefix}messages:${remoteId}` : null
    } catch {
      return null
    }
  }

  private async readRepo(key: string): Promise<StoredRepo> {
    const raw = await this.storage.getItem(key)
    if (!raw) return { messages: [] }
    try {
      const parsed = JSON.parse(raw)
      if (parsed && Array.isArray(parsed.messages)) return parsed as StoredRepo
    } catch {}
    return { messages: [] }
  }

  private toEntry(item: MessageFormatItem<TMessage>): StoredEntry {
    return {
      id: this.format.getId(item.message),
      parent_id: item.parentId,
      format: this.format.format,
      content: this.format.encode(item)
    }
  }

  async load(): Promise<MessageFormatRepository<TMessage>> {
    const key = this.key()
    if (!key) return { messages: [] }
    const repo = await this.readRepo(key)
    return { headId: repo.headId, messages: repo.messages.map(entry => this.format.decode(entry)) }
  }

  async append(item: MessageFormatItem<TMessage>): Promise<void> {
    const key = this.key()
    if (!key) return
    const repo = await this.readRepo(key)
    repo.messages.push(this.toEntry(item))
    repo.headId = this.format.getId(item.message)
    await this.storage.setItem(key, JSON.stringify(repo))
  }

  async update(item: MessageFormatItem<TMessage>, localMessageId?: string): Promise<void> {
    const key = this.key()
    if (!key) return
    const repo = await this.readRepo(key)
    const id = localMessageId ?? this.format.getId(item.message)
    const idx = repo.messages.findIndex(m => m.id === id)
    if (idx >= 0) repo.messages[idx] = this.toEntry(item)
    else repo.messages.push(this.toEntry(item))
    repo.headId = id
    await this.storage.setItem(key, JSON.stringify(repo))
  }

  async delete(items: MessageFormatItem<TMessage>[]): Promise<void> {
    const key = this.key()
    if (!key) return
    const repo = await this.readRepo(key)
    const ids = new Set(items.map(item => this.format.getId(item.message)))
    repo.messages = repo.messages.filter(m => !ids.has(m.id))
    await this.storage.setItem(key, JSON.stringify(repo))
  }

  pin(): void {}

  reportTelemetry(): void {}
}

/**
 * Persists chat history to localStorage, keyed by thread remote id, in the
 * AI SDK message format. Implements `withFormat` which `useChatRuntime`
 * (via `useAISDKRuntime`) requires of its history adapter.
 */
export class VulcainHistoryAdapter implements ThreadHistoryAdapter {
  constructor(
    private readonly storage: AsyncStorageLike,
    private readonly prefix: string,
    private readonly getAui: GetAui
  ) {}

  withFormat<TMessage, TStorageFormat extends Record<string, unknown>>(
    formatAdapter: MessageFormatAdapter<TMessage, TStorageFormat>
  ): GenericThreadHistoryAdapter<TMessage> {
    return new VulcainFormattedHistoryAdapter(
      this.storage,
      this.prefix,
      this.getAui,
      formatAdapter as MessageFormatAdapter<TMessage, Record<string, unknown>>
    ) as GenericThreadHistoryAdapter<TMessage>
  }

  async load() {
    return { messages: [] }
  }

  async append() {}
}