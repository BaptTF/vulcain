import type { SearchResult } from './providers.ts'

export function dedupeByUrl(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>()
  const out: SearchResult[] = []
  for (const r of results) {
    if (!r.url || seen.has(r.url)) continue
    seen.add(r.url)
    out.push(r)
  }
  return out
}

export function rankByScore(results: SearchResult[]): SearchResult[] {
  return [...results].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
}

export function formatSearchResults(query: string, results: SearchResult[], answer?: string): string {
  if (results.length === 0) {
    if (answer) return `Search results for "${query}" (refs e1, e2... are clickable):\n\n${answer}`
    return `No results for "${query}".`
  }
  const lines: string[] = [`Search results for "${query}":`, '']
  results.forEach((r, i) => {
    lines.push(`${i + 1}. **${r.title}** — ${r.url}`)
    const excerpt = (r.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 280)
    if (excerpt) lines.push(`   ${excerpt}`)
    lines.push('')
  })
  if (answer) lines.push(`Answer: ${answer}`)
  return lines.join('\n')
}

export function buildBrief(topic: string, answer: string | undefined, results: SearchResult[], sources: SearchResult[]): string {
  const lines: string[] = []
  lines.push(`## Recherche : ${topic}`)
  if (answer) lines.push(`\n**Réponse courte :** ${answer}\n`)
  lines.push(`\n### Résultats (${results.length})\n`)
  results.forEach(r => {
    const refIdx = sources.findIndex(s => s.url === r.url)
    const ref = refIdx >= 0 ? `[${refIdx + 1}]` : ''
    lines.push(`${ref} **${r.title}** — ${r.url}`)
    const excerpt = (r.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
    if (excerpt) lines.push(`    ${excerpt}`)
    if (r.engine) lines.push(`    (${r.engine})`)
    lines.push('')
  })
  lines.push('### Sources')
  lines.push('')
  sources.forEach((s, i) => {
    lines.push(`${i + 1}. [${s.title}](${s.url})`)
  })
  return lines.join('\n')
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'research'
  )
}