import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  keymap,
  lineNumbers
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  foldGutter,
  indentOnInput,
  syntaxHighlighting
} from '@codemirror/language'
import { closeBrackets } from '@codemirror/autocomplete'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages as codeLanguages } from '@codemirror/language-data'
import { json } from '@codemirror/lang-json'
import { tags as t } from '@lezer/highlight'
import { indentWithTab } from '@codemirror/commands'
import { toast } from 'sonner'
import { subscribeWatch } from '../watch-client'
import * as api from '../api'
import { bytesToBase64, typstPdfBytes } from '../typst'
import { MarkdownView, TypstView } from './Preview'

export interface Tab {
  path: string
}

interface Props {
  ws: string
  tabs: Tab[]
  activePath: string | null
  onActivate: (path: string) => void
  onClose: (path: string) => void
  flushRef?: MutableRefObject<(() => void) | null>
}

const vulcainHighlight = HighlightStyle.define([
  { tag: t.heading, color: 'var(--hl-heading)', fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--hl-link)', textDecoration: 'underline' },
  { tag: t.comment, color: 'var(--hl-comment)', fontStyle: 'italic' },
  { tag: t.keyword, color: 'var(--hl-keyword)' },
  { tag: t.string, color: 'var(--hl-string)' },
  { tag: t.number, color: 'var(--hl-number)' },
  { tag: t.variableName, color: 'var(--accent)' },
  { tag: t.typeName, color: 'var(--hl-number)' },
  { tag: t.meta, color: 'var(--muted)' }
])

const cmTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', height: '100%' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--muted)' },
  '.cm-activeLine': { background: 'var(--accent-soft)' },
  '.cm-activeLineGutter': { background: 'var(--accent-soft)' },
  '.cm-selectionBackground, ::selection': { background: 'var(--accent-soft)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' }
})

const TypstLang = StreamLanguage.define({
  name: 'typst',
  token(stream) {
    if (stream.match('//')) {
      stream.skipToEnd()
      return 'comment'
    }
    if (stream.match(/^"(\\.|[^"\\])*"/)) return 'string'
    if (stream.sol() && stream.match(/^=+[^=]*/)) return 'meta'
    if (stream.match(/^\$[^$]*\$/)) return 'string'
    if (stream.sol() && stream.match(/^\s*(?:[-+*]|\d+\.)\s/)) return 'keyword'
    if (stream.match(/^[A-Za-z_][\w-]*(?=\s*\()/)) return 'keyword'
    if (stream.match(/^@[A-Za-z0-9_.\-/]+/)) return 'typeName'
    if (stream.match(/^#[A-Za-z][\w.]*/)) return 'variableName'
    if (stream.match(/^\d+(\.\d+)*(em|pt|cm|mm|in|deg|%|fr|px)?/)) return 'number'
    stream.next()
    return null
  }
})

function langExtensions(path: string): Extension[] {
  if (/\.md$/i.test(path)) return [markdown({ base: markdownLanguage, codeLanguages })]
  if (/\.json$/i.test(path)) return [json()]
  if (/\.typ$/i.test(path)) return [TypstLang]
  return []
}

const baseExtensions: Extension[] = [
  lineNumbers(),
  foldGutter(),
  history(),
  drawSelection(),
  dropCursor(),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  highlightActiveLine(),
  syntaxHighlighting(vulcainHighlight),
  cmTheme,
  keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap])
]

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i

const AUTOSAVE_DELAY = 1000
const SAVE_GUARD_WINDOW = 400

export default function EditorPane({ ws, tabs, activePath, onActivate, onClose, flushRef }: Props) {
  const [contents, setContents] = useState<Record<string, string>>({})
  const [dirty, setDirty] = useState<Record<string, boolean>>({})
  const [previewOn, setPreviewOn] = useState(true)
  const contentsRef = useRef<Record<string, string>>({})
  contentsRef.current = contents
  const dirtyRef = useRef<Record<string, boolean>>({})
  dirtyRef.current = dirty
  const saveTimersRef = useRef<Record<string, number>>({})
  const saveGuardRef = useRef<Record<string, number>>({})

  const doSave = useCallback(
    async (path: string): Promise<void> => {
      const content = contentsRef.current[path]
      if (content === undefined) return
      try {
        await api.writeFile(ws, path, content)
        saveGuardRef.current[path] = Date.now()
        setDirty(d => (d[path] ? { ...d, [path]: false } : d))
      } catch (e: any) {
        toast.error('Sauvegarde impossible', { description: e.message })
      }
    },
    [ws]
  )

  const flush = useCallback(() => {
    for (const path of Object.keys(dirtyRef.current)) {
      if (!dirtyRef.current[path]) continue
      const timer = saveTimersRef.current[path]
      if (timer) {
        window.clearTimeout(timer)
        delete saveTimersRef.current[path]
      }
      void doSave(path)
    }
  }, [doSave])

  useEffect(() => {
    if (flushRef) flushRef.current = flush
    return () => {
      if (flushRef) flushRef.current = null
    }
  }, [flush, flushRef])

  useEffect(() => {
    const onBeforeUnload = () => flush()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [flush])

  const loadFile = useCallback(
    (path: string, opts?: { force?: boolean }) => {
      if (!opts?.force && contentsRef.current[path] !== undefined) return
      let cancelled = false
      api
        .readFile(ws, path)
        .then(c => {
          if (!cancelled) {
            setContents(prev => ({ ...prev, [path]: c }))
            setDirty(d => (d[path] ? { ...d, [path]: false } : d))
          }
        })
        .catch(e => {
          if (!cancelled) setContents(prev => ({ ...prev, [path]: `// erreur de lecture: ${e.message}` }))
        })
      return () => {
        cancelled = true
      }
    },
    [ws]
  )

  useEffect(() => {
    if (activePath) loadFile(activePath)
  }, [activePath, loadFile])

  const save = useCallback(async () => {
    if (!activePath) return
    await doSave(activePath)
  }, [activePath, doSave])

  useEffect(() => {
    const timers: number[] = []
    const unsub = subscribeWatch(ws, msg => {
      if (msg.event !== 'change') return
      if (!tabs.some(t => t.path === msg.path)) return
      const lastSave = saveGuardRef.current[msg.path] ?? 0
      if (Date.now() - lastSave < SAVE_GUARD_WINDOW) return
      const timer = window.setTimeout(() => {
        if (!dirtyRef.current[msg.path]) loadFile(msg.path, { force: true })
      }, 200)
      timers.push(timer)
    })
    return () => {
      for (const t of timers) window.clearTimeout(t)
      unsub()
    }
  }, [ws, tabs, loadFile])

  const handleChange = useCallback(
    (path: string, value: string) => {
      setContents(prev => ({ ...prev, [path]: value }))
      setDirty(d => ({ ...d, [path]: true }))
      const existing = saveTimersRef.current[path]
      if (existing) window.clearTimeout(existing)
      saveTimersRef.current[path] = window.setTimeout(() => {
        delete saveTimersRef.current[path]
        void doSave(path)
      }, AUTOSAVE_DELAY)
    },
    [doSave]
  )

  const handleClose = useCallback(
    (path: string) => {
      if (dirtyRef.current[path]) {
        const timer = saveTimersRef.current[path]
        if (timer) {
          window.clearTimeout(timer)
          delete saveTimersRef.current[path]
        }
        void doSave(path)
      }
      onClose(path)
    },
    [doSave, onClose]
  )

  const content = activePath ? contents[activePath] ?? '' : ''
  const isMd = !!activePath && /\.md$/i.test(activePath)
  const isTyp = !!activePath && /\.typ$/i.test(activePath)
  const showPreview = previewOn && (isMd || isTyp)

  const exportPdf = useCallback(async () => {
    if (!activePath || !content) return
    try {
      const bytes = await typstPdfBytes(content)
      const pdfPath = activePath.replace(/\.typ$/i, '') + '.pdf'
      await api.writeFileBase64(ws, pdfPath, bytesToBase64(bytes))
      const name = pdfPath.split('/').pop() ?? 'document.pdf'
      const a = document.createElement('a')
      a.href = api.downloadUrl(ws, pdfPath)
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (e: any) {
      toast.error('Compilation impossible', { description: String(e?.message ?? e) })
    }
  }, [ws, activePath, content])

  return (
    <>
      <div className="tabbar">
        {tabs.map(t => (
          <div
            key={t.path}
            className={`tab${t.path === activePath ? ' active' : ''}`}
            onClick={() => onActivate(t.path)}
            title={t.path}
          >
            {dirty[t.path] && <span className="dirty-dot" />}
            <span>{t.path.split('/').pop()}</span>
            <button
              className="icon-btn"
              onClick={e => {
                e.stopPropagation()
                handleClose(t.path)
              }}
            >
              ×
            </button>
          </div>
        ))}
        {(isMd || isTyp) && (
          <div className="preview-toolbar">
            <button className="btn" onClick={() => setPreviewOn(v => !v)}>
              {showPreview ? 'Édition seule' : 'Preview'}
            </button>
            {isTyp && (
              <button className="btn primary" onClick={exportPdf}>
                Compiler PDF
              </button>
            )}
          </div>
        )}
      </div>
      {!activePath ? (
        <div className="empty-state">Ouvrez un fichier dans l'arbre à gauche</div>
      ) : IMAGE_EXT.test(activePath) ? (
        <div className="editor-area" style={{ alignItems: 'center', justifyContent: 'center', display: 'flex' }}>
          <img src={api.fileUrl(ws, activePath)} style={{ maxWidth: '90%', maxHeight: '90%' }} alt={activePath} />
        </div>
      ) : /\.pdf$/i.test(activePath) ? (
        <iframe src={api.fileUrl(ws, activePath)} style={{ flex: 1, border: 'none' }} title={activePath} />
      ) : (
        <div className="editor-area">
          {showPreview ? (
            <div className="editor-split">
              <div className="editor-half">
                <div className="cm-editor-host">
                  <CodeEditor
                    key={`${ws}:${activePath}`}
                    value={content}
                    extensions={langExtensions(activePath)}
                    onChange={v => handleChange(activePath, v)}
                    onSave={save}
                  />
                </div>
              </div>
              {isMd ? <MarkdownView source={content} /> : <TypstView source={content} />}
            </div>
          ) : (
            <div className="editor-half">
              <div className="cm-editor-host">
                <CodeEditor
                  key={`${ws}:${activePath}`}
                  value={content}
                  extensions={langExtensions(activePath)}
                  onChange={v => handleChange(activePath, v)}
                  onSave={save}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </>
  )
}

function CodeEditor({
  value,
  onChange,
  onSave,
  extensions
}: {
  value: string
  onChange: (v: string) => void
  onSave: () => void
  extensions: Extension[]
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const syncingRef = useRef(false)

  useEffect(() => {
    if (!hostRef.current) return
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          ...baseExtensions,
          ...extensions,
          EditorView.updateListener.of(update => {
            if (update.docChanged && !syncingRef.current) onChangeRef.current(update.state.doc.toString())
          }),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                onSaveRef.current()
                return true
              }
            }
          ])
        ]
      })
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [])

  useEffect(() => {
    const v = viewRef.current
    if (!v) return
    if (v.state.doc.toString() !== value) {
      syncingRef.current = true
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } })
      syncingRef.current = false
    }
  }, [value])

  return <div ref={hostRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }} />
}
