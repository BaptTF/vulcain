import { useState, type ReactNode } from 'react'
import {
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  groupPartByType,
  useAuiState
} from '@assistant-ui/react'
import { renderMarkdown } from '../../markdown'

const GROUP = groupPartByType({
  reasoning: ['group-chainOfThought', 'group-reasoning'],
  'tool-call': ['group-chainOfThought', 'group-tool'],
  'standalone-tool-call': []
})

const KIND_BY_TOOL: Record<string, string> = {
  read: 'read',
  write: 'edit',
  edit: 'edit',
  bash: 'bash',
  grep: 'search',
  find: 'search',
  ls: 'search',
  web_search: 'search',
  web_research: 'fetch',
  web_read: 'fetch',
  browser_screenshot: 'other'
}

function toolTitle(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const record = args as Record<string, unknown>
  if (typeof record.path === 'string') return `${toolName} ${record.path}`
  if (typeof record.command === 'string') return `${toolName} ${record.command.slice(0, 60)}`
  if (typeof record.query === 'string') return `${toolName} "${record.query.slice(0, 60)}"`
  return undefined
}

export function AuiThread({ onOpenFile }: { onOpenFile: (path: string) => void }): ReactNode {
  return (
    <ThreadPrimitive.Root className="aui-thread">
      <ThreadPrimitive.Viewport turnAnchor="top" className="aui-viewport">
        <div className="aui-thread-scroll">
          <div className="aui-messages">
            <ThreadPrimitive.Messages>{() => <AuiMessage onOpenFile={onOpenFile} />}</ThreadPrimitive.Messages>
          </div>
          <div className="aui-thread-footer">
            <AuiComposer />
          </div>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  )
}

function AuiMessage({ onOpenFile }: { onOpenFile: (path: string) => void }): ReactNode {
  const role = useAuiState((s: any) => s.message.role)
  if (role === 'user') return <AuiUserMessage />
  return <AuiAssistantMessage onOpenFile={onOpenFile} />
}

function AuiUserMessage(): ReactNode {
  return (
    <MessagePrimitive.Root className="aui-msg aui-msg-user" data-role="user">
      <div className="aui-user-bubble">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  )
}

function AuiAssistantMessage({ onOpenFile }: { onOpenFile: (path: string) => void }): ReactNode {
  return (
    <MessagePrimitive.Root className="aui-msg aui-msg-assistant" data-role="assistant">
      <MessagePrimitive.GroupedParts groupBy={GROUP}>
        {({ part, children }: any) => {
          switch (part.type) {
            case 'group-chainOfThought':
              return <div className="aui-chain">{children}</div>
            case 'group-tool':
              return <div className="aui-tool-group">{children}</div>
            case 'group-reasoning':
              return <AuiReasoningGroup>{children}</AuiReasoningGroup>
            case 'text':
              return <MessagePartPrimitive.Text component={AuiMarkdown as any} />
            case 'reasoning':
              return <AuiReasoningText />
            case 'tool-call':
              return part.toolUI ?? <AuiToolCard part={part} onOpenFile={onOpenFile} />
            case 'indicator':
              return (
                <span className="aui-indicator" aria-label="Agent en cours">
                  ●
                </span>
              )
            default:
              return null
          }
        }}
      </MessagePrimitive.GroupedParts>
    </MessagePrimitive.Root>
  )
}

function AuiMarkdown({ children }: { children?: ReactNode }): ReactNode {
  const text = typeof children === 'string' ? children : ''
  const html = text ? renderMarkdown(text) : ''
  return <div className="md-body aui-markdown" dangerouslySetInnerHTML={{ __html: html }} />
}

function AuiReasoningText(): ReactNode {
  const text = useAuiState((s: any) => (s.part?.type === 'reasoning' ? s.part.text : ''))
  if (!text) return null
  return (
    <div className="aui-reasoning-body">
      <MessagePartPrimitive.Text component={AuiMarkdown as any} />
    </div>
  )
}

function AuiReasoningGroup({ children }: { children: ReactNode }): ReactNode {
  return (
    <details className="aui-reasoning">
      <summary className="aui-reasoning-summary">Réflexion</summary>
      <div className="aui-reasoning-body">{children}</div>
    </details>
  )
}

type AuiToolPart = {
  toolName?: string
  args?: unknown
  result?: unknown
  isError?: boolean
  status?: { type?: string }
}

function AuiToolCard({ part, onOpenFile }: { part: AuiToolPart; onOpenFile: (path: string) => void }): ReactNode {
  const { toolName = 'outil', args, result, isError, status } = part
  const [expanded, setExpanded] = useState(false)
  const title = toolTitle(toolName, args) ?? toolName
  const kind = KIND_BY_TOOL[toolName] ?? 'other'
  const running = status?.type === 'running'
  const path = args && typeof args === 'object' ? (args as Record<string, unknown>).path : undefined

  const resultText = typeof result === 'string' ? result : result ? JSON.stringify(result) : ''

  return (
    <div className={`tool-card${running ? ' running' : ''}`}>
      <div className="tool-card-header" onClick={() => setExpanded(e => !e)}>
        <span className="tool-kind">{kind}</span>
        <span className="tool-card-title">{title}</span>
        <span className={`tool-status ${running ? 'in_progress' : isError ? 'failed' : 'completed'}`}>
          {running ? 'en cours' : isError ? 'erreur' : 'terminé'}
        </span>
      </div>
      {typeof path === 'string' && (
        <div className="tool-card-location">
          <a
            href="#"
            onClick={e => {
              e.preventDefault()
              onOpenFile(path as string)
            }}
          >
            {path}
          </a>
        </div>
      )}
      {(expanded || running) && (
        <div className="tool-detail">
          {args !== undefined && <pre className="tool-args">{JSON.stringify(args, null, 2)}</pre>}
          {resultText && <pre className="tool-result">{resultText}</pre>}
        </div>
      )}
    </div>
  )
}

function AuiComposer(): ReactNode {
  const isRunning = useAuiState((s: any) => s.thread.isRunning)
  return (
    <ComposerPrimitive.Root className="aui-composer">
      <ComposerPrimitive.Input
        className="aui-composer-input"
        placeholder="Écrivez à l'agent… (Entrée pour envoyer)"
        rows={2}
        autoFocus={false}
      />
      <div className="aui-composer-actions">
        {isRunning ? (
          <ComposerPrimitive.Cancel asChild>
            <button type="button" className="btn danger">
              Stop
            </button>
          </ComposerPrimitive.Cancel>
        ) : (
          <ComposerPrimitive.Send asChild>
            <button type="button" className="btn primary">
              Envoyer
            </button>
          </ComposerPrimitive.Send>
        )}
      </div>
    </ComposerPrimitive.Root>
  )
}