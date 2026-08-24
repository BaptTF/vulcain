import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import type { VulcainConfig } from './config.js'

export function syncPiModels(cfg: VulcainConfig): string | undefined {
  const provider = cfg.llm?.provider as
    | { name?: string; baseUrl?: string; api?: string; apiKey?: string; models?: unknown[] }
    | undefined
  if (!provider || !provider.baseUrl || !provider.api) return undefined

  const dir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent')
  fs.mkdirSync(dir, { recursive: true })

  const name = provider.name ?? 'custom'
  const doc = {
    providers: {
      [name]: {
        baseUrl: provider.baseUrl,
        api: provider.api,
        ...(provider.apiKey !== undefined ? { apiKey: provider.apiKey } : {}),
        models: provider.models ?? []
      }
    }
  }
  const file = path.join(dir, 'models.json')
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n')
  return file
}
