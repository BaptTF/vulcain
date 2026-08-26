import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.setPrompt('')
let sessionId = 0

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

rl.on('line', line => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = msg

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'fake-agent', version: '0.0.1' },
        authMethods: [],
        promptCapabilities: {}
      }
    })
    return
  }

  if (method === 'session/new') {
    sessionId = `fake-${Date.now()}`
    send({ jsonrpc: '2.0', id, result: { sessionId } })
    return
  }

  if (method === 'session/load') {
    send({ jsonrpc: '2.0', id, result: { sessionId: params.sessionId } })
    return
  }

  if (method === 'session/prompt') {
    const text = (params.prompt ?? []).map(b => b.text ?? '').join('')
    if (text === '__exit__') {
      process.exit(0)
    }
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo: ${text}` } }
      }
    })
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: `Read ${params.cwd ?? '.'}/welcome.md`,
          kind: 'read',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'file contents here' } }]
        }
      }
    })
    send({
      jsonrpc: '2.0',
      method: 'session/request_permission',
      id: `perm-${id}`,
      params: {
        sessionId,
        options: [
          { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
          { optionId: 'deny', kind: 'reject_once', name: 'Deny' }
        ]
      }
    })
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
    return
  }

  if (method === 'session/cancel') {
    return
  }

  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } })
  }
})
