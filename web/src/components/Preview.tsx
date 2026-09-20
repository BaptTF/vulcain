import { useEffect, useMemo, useState } from 'react'
import { renderMarkdown } from '../markdown'
import * as api from '../api'
import { bytesToBase64, siblingPdfPath, ensureTypstCompiler, typstPdfBytes } from '../typst'
import { PdfViewer } from './PdfViewer'

const COMPILE_DEBOUNCE = 500

export function MarkdownView({ source }: { source: string }) {
  const html = useMemo(() => renderMarkdown(source), [source])
  return <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />
}

export function TypstView({ ws, path, source }: { ws: string; path: string; source: string }) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null)
  const [err, setErr] = useState('')
  const pdfPath = siblingPdfPath(path)

  useEffect(() => {
    let cancelled = false
    void ensureTypstCompiler()
    api
      .readFileBytes(ws, pdfPath)
      .then(existing => {
        if (!cancelled && existing) setBytes(existing)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [ws, pdfPath])

  useEffect(() => {
    if (!source) return
    let cancelled = false
    const timer = window.setTimeout(async () => {
      try {
        const out = await typstPdfBytes(source)
        if (cancelled) return
        await api.writeFileBase64(ws, pdfPath, bytesToBase64(out))
        if (cancelled) return
        setBytes(out)
        setErr('')
      } catch (e: any) {
        if (!cancelled) setErr(String(e?.message ?? e))
      }
    }, COMPILE_DEBOUNCE)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [ws, pdfPath, source])

  return (
    <div className="typ-preview">
      {err ? <pre className="typ-error">{err}</pre> : null}
      {bytes ? <PdfViewer file={bytes} /> : err ? null : <div className="empty-state">Compilation…</div>}
    </div>
  )
}
