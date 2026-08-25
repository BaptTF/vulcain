import { useEffect, useMemo, useRef, useState } from 'react'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import { typstSvg } from '../typst'

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
}

const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(code: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<code class="hljs">${hljs.highlight(code, { language: lang }).value}</code>`
      } catch {}
    }
    return `<code class="hljs">${escapeHtml(code)}</code>`
  }
})

export function MarkdownView({ source }: { source: string }) {
  const html = useMemo(() => DOMPurify.sanitize(md.render(source)), [source])
  return <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />
}

export function TypstView({ source }: { source: string }) {
  const [svg, setSvg] = useState('')
  const [err, setErr] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(async () => {
      try {
        const out = await typstSvg(source)
        if (!cancelled) {
          setSvg(out)
          setErr('')
        }
      } catch (e: any) {
        if (!cancelled) setErr(String(e?.message ?? e))
      }
    }, 500)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [source])

  useEffect(() => {
    if (!svg || !containerRef.current) return
    const svgElem = containerRef.current.querySelector('svg')
    if (!svgElem) return
    const w = Number.parseFloat(svgElem.getAttribute('width') ?? '')
    const h = Number.parseFloat(svgElem.getAttribute('height') ?? '')
    if (!w || !h) return
    const cw = containerRef.current.clientWidth
    svgElem.setAttribute('width', String(cw))
    svgElem.setAttribute('height', String((h * cw) / w))
  }, [svg])

  return (
    <div className="preview-pane">
      {err ? (
        <pre className="typ-error">{err}</pre>
      ) : (
        <div className="typ-body" ref={containerRef} dangerouslySetInnerHTML={{ __html: svg }} />
      )}
    </div>
  )
}
