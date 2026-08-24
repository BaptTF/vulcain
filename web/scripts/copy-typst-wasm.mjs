#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(here, '..')
const destDir = path.join(webRoot, 'public', 'assets')
fs.mkdirSync(destDir, { recursive: true })

const require = createRequire(path.join(webRoot, 'package.json'))

function resolvePkgDir(name) {
  const pkgJson = require.resolve(`${name}/package.json`)
  return path.dirname(pkgJson)
}

function versionOf(name) {
  return JSON.parse(fs.readFileSync(path.join(resolvePkgDir(name), 'package.json'), 'utf8')).version
}

const glue = '@myriaddreamin/typst.ts'
const glueVersion = versionOf(glue)

const sources = [
  ['@myriaddreamin/typst-ts-web-compiler', 'pkg/typst_ts_web_compiler_bg.wasm', 'typst_ts_web_compiler_bg.wasm'],
  ['@myriaddreamin/typst-ts-renderer', 'pkg/typst_ts_renderer_bg.wasm', 'typst_ts_renderer_bg.wasm']
]

let failed = false
for (const [name, relSrc, outName] of sources) {
  const version = versionOf(name)
  if (version !== glueVersion) {
    console.error(
      `[copy-wasm] ABI mismatch: ${glue}@${glueVersion} (glue JS) vs ${name}@${version} (wasm).\n` +
        `The wasm binary must be built with the same release as the typst.ts glue, otherwise\n` +
        `instantiation fails with "import object field 'wbg' is not an Object".\n` +
        `Fix: pin ${name} to ${glueVersion} in web/package.json.`
    )
    failed = true
    continue
  }
  const src = path.join(resolvePkgDir(name), relSrc)
  fs.copyFileSync(src, path.join(destDir, outName))
  console.log(`[copy-wasm] ${outName} (${version})`)
}

if (failed) process.exit(1)
