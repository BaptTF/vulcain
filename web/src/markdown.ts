import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'

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

export function renderMarkdown(source: string): string {
  return DOMPurify.sanitize(md.render(source))
}