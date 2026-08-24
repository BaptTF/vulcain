import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Type } from 'typebox'

interface CamofoxConfig {
  baseUrl?: string
  accessKey?: string
}

interface WebSearchConfig {
  provider?: string
  macro?: string
}

function loadVulcainConfig(): { tools?: { camofox?: CamofoxConfig; webSearch?: WebSearchConfig } } {
  const base = process.env.VULCAIN_HOME || path.join(os.homedir(), '.vulcain')
  try {
    return JSON.parse(fs.readFileSync(path.join(base, 'config', 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}

function camofoxBase(): string {
  const c = loadVulcainConfig().tools?.camofox
  return (c?.baseUrl ?? 'http://127.0.0.1:9377').replace(/\/+$/, '')
}

async function camofox(method: string, urlPath: string, body?: unknown): Promise<any> {
  const accessKey = loadVulcainConfig().tools?.camofox?.accessKey
  const res = await fetch(`${camofoxBase()}${urlPath}`, {
    method,
    headers: {
      ...(accessKey ? { authorization: `Bearer ${accessKey}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`camofox ${method} ${urlPath} -> ${res.status}: ${text.slice(0, 500)}`)
  }
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) return res.json()
  return Buffer.from(await res.arrayBuffer())
}

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
      'Search the web via the stealth browser (Google). Returns a text snapshot of results. Use browser_* tools to open and read a result page.',
    parameters: Type.Object({
      query: Type.String({ description: 'The search query' })
    }),
    async execute(_id: string, params: any) {
      const search = loadVulcainConfig().tools?.webSearch
      const macro = search?.macro ?? '@google_search'
      let tabId = ''
      try {
        const tab = await camofox('POST', '/tabs', { userId: 'vulcain', sessionKey: 'vulcain-search' })
        tabId = tab.tabId
        await camofox('POST', `/tabs/${tabId}/navigate`, { userId: 'vulcain', macro, query: params.query })
        const snap = await snapshot(tabId)
        return {
          content: [{ type: 'text', text: `Search results for "${params.query}" (refs e1, e2... are clickable):\n\n${snap}` }],
          details: {}
        }
      } finally {
        if (tabId) void closeTabQuietly(tabId)
      }
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
      const snap = await snapshot(tab.tabId)
      return {
        content: [
          {
            type: 'text',
            text: `Opened ${params.url} (tabId=${tab.tabId}).\n\n${snap}`
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
