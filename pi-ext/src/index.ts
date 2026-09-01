import fs from 'node:fs'
import path from 'node:path'
import { Type } from 'typebox'
import { camofox, loadVulcainConfig } from './providers.ts'
import { formatSearchResults } from './format.ts'
import { runResearch, runSearch } from './research.ts'
import { readUrl } from './providers.ts'

async function snapshot(tabId: string, extraQuery = ''): Promise<string> {
  const data = await camofox('GET', `/tabs/${tabId}/snapshot?userId=vulcain${extraQuery}`)
  const snap = typeof data === 'string' ? data : (data.snapshot ?? JSON.stringify(data))
  return String(snap).slice(0, 12000)
}

async function closeTabQuietly(tabId: string): Promise<void> {
  try {
    await camofox('DELETE', `/tabs/${tabId}?userId=vulcain`)
  } catch {}
}

export default function (pi: any) {
  pi.registerTool({
    name: 'web_search',
    label: 'Web Search',
    description:
      'Search the web (SearXNG metasearch by default, or Tavily). Returns ranked results with titles, URLs and snippets. Use web_read to extract a page fast, or browser_open for full control.',
    parameters: Type.Object({
      query: Type.String({ description: 'The search query' }),
      category: Type.Optional(Type.String({ description: 'Result category: general, news, science, academic, it, files (SearXNG) or news, finance (Tavily)' })),
      timeRange: Type.Optional(Type.String({ description: 'Time range: day, week, month, year' })),
      engines: Type.Optional(Type.Array(Type.String(), { description: 'Subset of the configured SearXNG engines to use (e.g. ["wikipedia"], ["bing","brave"]). Falls back to the configured engines.' })),
      maxResults: Type.Optional(Type.Number({ description: 'Max results (default from config, 10)' }))
    }),
    async execute(_id: string, params: any) {
      const cfg = loadVulcainConfig().tools ?? {}
      const resp = await runSearch(cfg, {
        query: params.query,
        category: params.category,
        timeRange: params.timeRange,
        engines: params.engines,
        maxResults: params.maxResults
      })
      return { content: [{ type: 'text', text: formatSearchResults(params.query, resp.results, resp.answer) }], details: {} }
    }
  })

  pi.registerTool({
    name: 'web_research',
    label: 'Web Research',
    description:
      'Agentic multi-query research. Fires the topic and optional subQueries in parallel across the configured search provider, merges and dedupes results, and returns a sourced markdown brief ([1], [2]...). With depth=deep it also extracts the top sources. With saveToNote it writes the brief to .research/<topic>.md in the workspace.',
    parameters: Type.Object({
      topic: Type.String({ description: 'The research topic / main query' }),
      subQueries: Type.Optional(Type.Array(Type.String(), { description: 'Additional queries to run in parallel' })),
      depth: Type.Optional(Type.Union([Type.Literal('quick'), Type.Literal('deep')], { description: 'deep extracts the top sources content' })),
      maxSources: Type.Optional(Type.Number({ description: 'Max sources to keep / extract (default 6)' })),
      category: Type.Optional(Type.String({ description: 'Result category (see web_search)' })),
      timeRange: Type.Optional(Type.String({ description: 'Time range: day, week, month, year' })),
      engines: Type.Optional(Type.Array(Type.String(), { description: 'Subset of the configured SearXNG engines (see web_search)' })),
      saveToNote: Type.Optional(Type.Boolean({ description: 'Write the brief to .research/<topic>.md in the workspace' }))
    }),
    async execute(_id: string, params: any) {
      const cfg = loadVulcainConfig().tools ?? {}
      const out = await runResearch(cfg, {
        topic: params.topic,
        subQueries: params.subQueries,
        depth: params.depth,
        maxSources: params.maxSources,
        category: params.category,
        timeRange: params.timeRange,
        engines: params.engines,
        saveToNote: params.saveToNote
      })
      return { content: [{ type: 'text', text: out.note ? `${out.brief}\n\nSaved to ${out.note}` : out.brief }], details: {} }
    }
  })

  pi.registerTool({
    name: 'web_read',
    label: 'Read URL',
    description:
      'Extract the readable text of a URL. Uses Tavily extract when a key is configured, otherwise the stealth browser. Faster than browser_open for static pages.',
    parameters: Type.Object({
      url: Type.String({ description: 'URL to read' })
    }),
    async execute(_id: string, params: any) {
      const cfg = loadVulcainConfig().tools ?? {}
      const text = await readUrl(cfg, params.url, globalThis.fetch)
      return { content: [{ type: 'text', text: `# ${params.url}\n\n${text.slice(0, 12000)}` }], details: {} }
    }
  })

  pi.registerTool({
    name: 'browser_open',
    label: 'Open Browser Tab',
    description:
      'Open a URL in the stealth browser. Returns an accessibility snapshot with stable element refs (e1, e2...) for use with browser_click/browser_type.',
    parameters: Type.Object({
      url: Type.String({ description: 'URL to open' }),
      sessionKey: Type.Optional(Type.String({ description: 'Tab group key, defaults to "agent"' }))
    }),
    async execute(_id: string, params: any) {
      const tab = await camofox('POST', '/tabs', {
        userId: 'vulcain',
        sessionKey: params.sessionKey ?? 'agent',
        url: params.url
      })
      return {
        content: [
          {
            type: 'text',
            text: `Opened ${params.url} (tabId=${tab.tabId}).\n\n${await snapshot(tab.tabId)}`
          }
        ],
        details: { tabId: tab.tabId }
      }
    }
  })

  pi.registerTool({
    name: 'browser_navigate',
    label: 'Navigate',
    description: 'Navigate an existing tab to a URL or a search macro (@google_search, @youtube_search...).',
    parameters: Type.Object({
      tabId: Type.String(),
      url: Type.Optional(Type.String()),
      macro: Type.Optional(Type.String({ description: 'e.g. @google_search' })),
      query: Type.Optional(Type.String({ description: 'query used with macro' }))
    }),
    async execute(_id: string, params: any) {
      const body: Record<string, unknown> = { userId: 'vulcain' }
      if (params.macro) {
        body.macro = params.macro
        body.query = params.query ?? ''
      } else {
        body.url = params.url
      }
      await camofox('POST', `/tabs/${params.tabId}/navigate`, body)
      return { content: [{ type: 'text', text: `Navigated.\n\n${await snapshot(params.tabId)}` }], details: {} }
    }
  })

  pi.registerTool({
    name: 'browser_snapshot',
    label: 'Page Snapshot',
    description: 'Get the current accessibility snapshot of a tab, optionally paginated.',
    parameters: Type.Object({
      tabId: Type.String(),
      offset: Type.Optional(Type.Number({ description: 'pagination offset for large pages' }))
    }),
    async execute(_id: string, params: any) {
      const q = params.offset ? `&offset=${params.offset}` : ''
      return { content: [{ type: 'text', text: await snapshot(params.tabId, q) }], details: {} }
    }
  })

  pi.registerTool({
    name: 'browser_click',
    label: 'Click Element',
    description: 'Click an element by ref (e1, e2... from a snapshot) or CSS selector.',
    parameters: Type.Object({
      tabId: Type.String(),
      ref: Type.String({ description: 'element ref like e12, or a CSS selector' })
    }),
    async execute(_id: string, params: any) {
      await camofox('POST', `/tabs/${params.tabId}/click`, { userId: 'vulcain', ref: params.ref })
      return { content: [{ type: 'text', text: `Clicked.\n\n${await snapshot(params.tabId)}` }], details: {} }
    }
  })

  pi.registerTool({
    name: 'browser_type',
    label: 'Type Text',
    description: 'Type text into an element by ref or CSS selector.',
    parameters: Type.Object({
      tabId: Type.String(),
      ref: Type.String(),
      text: Type.String(),
      pressEnter: Type.Optional(Type.Boolean())
    }),
    async execute(_id: string, params: any) {
      await camofox('POST', `/tabs/${params.tabId}/type`, {
        userId: 'vulcain',
        ref: params.ref,
        text: params.text,
        pressEnter: params.pressEnter ?? false
      })
      return { content: [{ type: 'text', text: `Typed.\n\n${await snapshot(params.tabId)}` }], details: {} }
    }
  })

  pi.registerTool({
    name: 'browser_scroll',
    label: 'Scroll Page',
    description: 'Scroll the page up/down/left/right.',
    parameters: Type.Object({
      tabId: Type.String(),
      direction: Type.Union([Type.Literal('up'), Type.Literal('down'), Type.Literal('left'), Type.Literal('right')])
    }),
    async execute(_id: string, params: any) {
      await camofox('POST', `/tabs/${params.tabId}/scroll`, { userId: 'vulcain', direction: params.direction })
      return { content: [{ type: 'text', text: `Scrolled.\n\n${await snapshot(params.tabId)}` }], details: {} }
    }
  })

  pi.registerTool({
    name: 'browser_screenshot',
    label: 'Screenshot',
    description: 'Take a screenshot of a tab and save it as PNG inside the workspace (.shots/ directory). Returns the saved path.',
    parameters: Type.Object({
      tabId: Type.String()
    }),
    async execute(_id: string, params: any) {
      const buf: Buffer = await camofox('GET', `/tabs/${params.tabId}/screenshot?userId=vulcain`)
      const dirName = '.shots'
      fs.mkdirSync(dirName, { recursive: true })
      const fileName = `${Date.now()}-${params.tabId.slice(0, 8)}.png`
      fs.writeFileSync(path.join(dirName, fileName), buf)
      return {
        content: [
          {
            type: 'text',
            text: `Screenshot saved to ${dirName}/${fileName} (${buf.length} bytes). Use the read tool on it to view it.`
          }
        ],
        details: { path: `${dirName}/${fileName}` }
      }
    }
  })

  pi.registerTool({
    name: 'browser_close',
    label: 'Close Tab',
    description: 'Close a browser tab.',
    parameters: Type.Object({
      tabId: Type.String()
    }),
    async execute(_id: string, params: any) {
      await closeTabQuietly(params.tabId)
      return { content: [{ type: 'text', text: 'Closed.' }], details: {} }
    }
  })
}