export class TtlCache<T> {
  private map = new Map<string, { expires: number; value: T }>()
  private readonly ttlMs: number

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs
  }

  get(key: string): T | undefined {
    const entry = this.map.get(key)
    if (!entry) return undefined
    if (Date.now() > entry.expires) {
      this.map.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: T): void {
    this.map.set(key, { expires: Date.now() + this.ttlMs, value })
  }

  clear(): void {
    this.map.clear()
  }
}

export class RateLimiter {
  private next = 0
  private readonly minIntervalMs: number

  constructor(minIntervalMs: number) {
    this.minIntervalMs = minIntervalMs
  }

  async wait(): Promise<void> {
    const now = Date.now()
    const delay = Math.max(0, this.next - now)
    this.next = now + delay + this.minIntervalMs
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}