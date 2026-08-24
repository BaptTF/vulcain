type Listener = (msg: { type: string; event: string; path: string }) => void

interface Entry {
  socket: WebSocket
  listeners: Set<Listener>
  retryTimer: number | null
  closed: boolean
}

const entries = new Map<string, Entry>()

export function subscribeWatch(ws: string, fn: Listener): () => void {
  let entry = entries.get(ws)
  if (!entry) {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(`${protocol}://${location.host}/api/watch?ws=${encodeURIComponent(ws)}`)
    entry = { socket, listeners: new Set(), retryTimer: null, closed: false }
    entries.set(ws, entry)

    socket.addEventListener('message', ev => {
      let msg: unknown
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      for (const l of entry!.listeners) {
        try {
          l(msg as any)
        } catch {}
      }
    })

    socket.addEventListener('close', () => {
      if (entry!.closed) return
      entries.delete(ws)
      entry!.retryTimer = window.setTimeout(() => {
        const current = [...entry!.listeners]
        for (const l of current) subscribeWatch(ws, l)
      }, 2000)
    })
  }
  entry.listeners.add(fn)
  return () => {
    entry!.listeners.delete(fn)
  }
}
