import { spawn } from 'node:child_process'
import type { FastifyInstance } from 'fastify'
import { findWorkspace, loadConfig } from './config.js'

export function registerAcpBridge(app: FastifyInstance): void {
  app.get('/api/acp', { websocket: true }, (sock, req) => {
    const q = req.query as { ws?: string }
    const cfg = loadConfig()
    const ws = findWorkspace(cfg, q.ws ?? '')
    if (!ws) {
      sock.close(4004, 'unknown workspace')
      return
    }

    const command = cfg.agent.command
    const args = [...command.slice(1), ...(cfg.agent.args ?? [])]
    let child
    try {
      child = spawn(command[0], args, {
        cwd: ws.root,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      sock.close(1011, `agent spawn failed: ${err}`)
      return
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      const msg =
        err.code === 'ENOENT'
          ? `agent introuvable : "${command[0]}" (installe-le ou change agent.command dans config.json)`
          : `agent process error: ${err.message}`
      try {
        sock.send(JSON.stringify({
          jsonrpc: '2.0',
          id: -1,
          error: { code: -32000, message: msg }
        }))
        sock.close(1011, msg)
      } catch {}
    })

    child.on('exit', (code, signal) => {
      try {
        sock.close(4000, `agent exited (${signal ?? code})`)
      } catch {}
    })

    child.stderr?.on('data', (d: Buffer) => {
      process.stderr.write(`[agent:${ws.name}] ${d}`)
    })

    let outBuf = ''
    child.stdout?.on('data', (chunk: Buffer) => {      outBuf += chunk.toString('utf8')
      let idx: number
      while ((idx = outBuf.indexOf('\n')) >= 0) {
        const line = outBuf.slice(0, idx).trim()
        outBuf = outBuf.slice(idx + 1)
        if (!line || !sock || sock.readyState !== sock.OPEN) continue
        try {
          sock.send(line)
        } catch {}
      }
    })

    sock.on('message', (data: Buffer) => {
      if (!child || !child.stdin || !child.stdin.writable) return
      let msg = data.toString()
      try {
        const parsed = JSON.parse(msg)
        rewriteCwd(parsed, ws.root)
        msg = JSON.stringify(parsed)
      } catch {}
      child.stdin.write(msg.endsWith('\n') ? msg : msg + '\n')
    })

    sock.on('close', () => {
      if (child && child.exitCode === null) {
        try {
          child.kill('SIGTERM')
        } catch {}
        setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {}
        }, 3000).unref()
      }
    })
  })
}

function rewriteCwd(msg: any, root: string): void {
  const params = msg && typeof msg === 'object' ? msg.params : undefined
  if (params && typeof params === 'object' && params.cwd === '.') {
    params.cwd = root
  }
}
