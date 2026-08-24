#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(here, '..')
const destDir = path.join(webRoot, 'public', 'assets')
fs.mkdirSync(destDir, { recursive: true })

const sources = [
  ['@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm', 'typst_ts_web_compiler_bg.wasm'],
  ['@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm', 'typst_ts_renderer_bg.wasm']
]

for (const [relSrc, name] of sources) {
  const candidates = [
    path.join(webRoot, 'node_modules', relSrc),
    path.join(webRoot, '..', 'node_modules', relSrc)
  ]
  const found = candidates.find(p => fs.existsSync(p))
  if (found) {
    fs.copyFileSync(found, path.join(destDir, name))
    console.log(`[copy-wasm] ${name}`)
  } else {
    console.warn(`[copy-wasm] missing ${relSrc}, skipping`)
  }
}
