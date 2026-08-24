import { useCallback, useEffect, useRef, useState } from 'react'
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
  onOpen: (path: string) => void
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

export default function EditorPane({ ws, tabs, activePath, onActivate, onClose, onOpen }: Props) {
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState<Record<string, boolean>>({})
  const [previewOn, setPreviewOn] = useState(true)
  const contentRef = useRef('')
  contentRef.current = content

  useEffect(() => {
    if (!activePath) {
      setContent('')
      return
    }
    let cancelled = false
    api
      .readFile(ws, activePath)
      .then(c => {
        if (!cancelled) setContent(c)
      })
      .catch(e => {
        if (!cancelled) setContent(`// erreur de lecture: ${e.message}`)
      })
    return () => {
      cancelled = true
    }
  }, [ws, activePath])

  const save = useCallback(async () => {
    if (!activePath) return
    try {
      await api.writeFile(ws, activePath, contentRef.current)
      setDirty(d => ({ ...d, [activePath]: false }))
    } catch (e: any) {
      alert(`Sauvegarde impossible : ${e.message}`)
    }
  }, [ws, activePath])

  useEffect(() => {
    let timer = 0
    const unsub = subscribeWatch(ws, msg => {
      if (!activePath || msg.path !== activePath || msg.event !== 'change') return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (!dirty[activePath]) {
          api
            .readFile(ws, activePath)
            .then(c => setContent(c))
            .catch(() => {})
        }
      }, 200)
    })
    return () => {
      window.clearTimeout(timer)
      unsub()
    }
  }, [ws, activePath, dirty])

  const isMd = !!activePath && /\.md$/i.test(activePath)
  const isTyp = !!activePath && /\.typ$/i.test(activePath)
  const showPreview = previewOn && (isMd || isTyp)

  const exportPdf = useCallback(async () => {
    if (!activePath || !contentRef.current) return
    try {
      const bytes = await typstPdfBytes(contentRef.current)
      const pdfPath = activePath.replace(/\.typ$/i, '') + '.pdf'
      await api.writeFileBase64(ws, pdfPath, bytesToBase64(bytes))
      onOpen(pdfPath)
    } catch (e: any) {
      alert(`Export PDF impossible : ${e?.message ?? e}`)
    }
  }, [ws, activePath, onOpen])

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
                onClose(t.path)
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
                Export PDF
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
                    onChange={v => {
                      setContent(v)
                      setDirty(d => ({ ...d, [activePath]: true }))
                    }}
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
                  onChange={v => {
                    setContent(v)
                    setDirty(d => ({ ...d, [activePath]: true }))
                  }}
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
            if (update.docChanged) onChangeRef.current(update.state.doc.toString())
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
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } })
    }
  }, [value])

  return <div ref={hostRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }} />
}
