import { useEffect, useMemo, useRef, useState } from 'react'
import { renderMarkdown } from '../markdown'
import * as api from '../api'
import { bytesToBase64, siblingPdfPath, ensureTypstCompiler, typstPdfBytes } from '../typst'
import { stampPreview } from '../preview-trace'
import { PdfViewer } from './PdfViewer'

export function MarkdownView({ source }: { source: string }) {
  const html = useMemo(() => renderMarkdown(source), [source])
  return <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />
}

export function TypstView({ ws, path, source }: { ws: string; path: string; source: string }) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null)
  const [err, setErr] = useState('')
  const pdfPath = siblingPdfPath(path)
  const writeGen = useRef(0)
  const inflight = useRef(false)
  const pending = useRef<{ ws: string; pdfPath: string; source: string; gen: number } | null>(null)

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
    const gen = ++writeGen.current
    pending.current = { ws, pdfPath, source, gen }
    stampPreview('armed')

    const drain = async () => {
      if (inflight.current) return
      inflight.current = true
      try {
        while (pending.current) {
          const job = pending.current
          pending.current = null
          stampPreview('compileStart')
          try {
            const out = await typstPdfBytes(job.source)
            stampPreview('compileEnd')
            if (job.gen !== writeGen.current) continue
            setBytes(out)
            stampPreview('bytesSet')
            setErr('')
            requestAnimationFrame(() => {
              if (job.gen !== writeGen.current) return
              void api.writeFileBase64(job.ws, job.pdfPath, bytesToBase64(out)).catch(() => {})
            })
          } catch (e: any) {
            if (job.gen === writeGen.current) setErr(String(e?.message ?? e))
          }
        }
      } finally {
        inflight.current = false
        if (pending.current) void drain()
      }
    }
    void drain()
  }, [ws, pdfPath, source])

  return (
    <div className="typ-preview">
      {err ? <pre className="typ-error">{err}</pre> : null}
      {bytes ? <PdfViewer file={bytes} /> : err ? null : <div className="empty-state">Compilation…</div>}
    </div>
  )
}
