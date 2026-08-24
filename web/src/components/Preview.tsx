import { useEffect, useMemo, useState } from 'react'
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

  return (
    <div className="preview-pane">
      {err ? <pre className="typ-error">{err}</pre> : <div className="typ-body" dangerouslySetInnerHTML={{ __html: svg }} />}
    </div>
  )
}
