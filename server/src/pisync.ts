import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { expandHome, type VulcainConfig } from './config.js'

export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent')
}

/**
 * Copy the configurable system prompt (SYSTEM.md) into pi's global agent dir,
 * where pi reads it to replace its default system prompt. Skips if the source
 * file is missing.
 */
export function syncSystemPrompt(cfg: VulcainConfig): string | undefined {
  const src = cfg.agent.systemPrompt ? expandHome(cfg.agent.systemPrompt) : undefined
  if (!src || !fs.existsSync(src)) return undefined

  const dir = piAgentDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'SYSTEM.md')
  fs.copyFileSync(src, file)
  return file
}

export function syncPiModels(cfg: VulcainConfig): string | undefined {
  const provider = cfg.llm?.provider as
    | { name?: string; baseUrl?: string; api?: string; apiKey?: string; models?: unknown[] }
    | undefined
  if (!provider || !provider.baseUrl || !provider.api) return undefined

  const dir = piAgentDir()
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
