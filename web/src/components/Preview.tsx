import { useEffect, useMemo, useRef, useState } from 'react'
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
  const writeGen = useRef(0)

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
    const gen = ++writeGen.current
    const timer = window.setTimeout(async () => {
      try {
        const out = await typstPdfBytes(source)
        if (cancelled) return
        setBytes(out)
        setErr('')
        // Paint the new PDF before the base64 + PUT; disk is for the sibling file / iframe.
        requestAnimationFrame(() => {
          if (cancelled || gen !== writeGen.current) return
          const b64 = bytesToBase64(out)
          if (cancelled || gen !== writeGen.current) return
          void api.writeFileBase64(ws, pdfPath, b64).catch(() => {})
        })
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
