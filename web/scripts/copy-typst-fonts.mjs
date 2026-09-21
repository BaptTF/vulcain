#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const destDir = path.resolve(here, '../public/fonts')
fs.mkdirSync(destDir, { recursive: true })

// Same commit as Debian's fonts-atkinson-hyperlegible package.
const ATKINSON_COMMIT = '1cb311624b2ddf88e9e37873999d165a8cd28b46'
const faces = ['Regular', 'Italic', 'Bold', 'BoldItalic']

let failed = false
for (const face of faces) {
  const name = `AtkinsonHyperlegible-${face}.otf`
  const url = `https://raw.githubusercontent.com/googlefonts/atkinson-hyperlegible/${ATKINSON_COMMIT}/fonts/otf/${name}`
  const dest = path.join(destDir, name)
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    fs.writeFileSync(dest, buf)
    console.log(`[copy-fonts] ${name} (${buf.length} bytes)`)
  } catch (err) {
    console.error(`[copy-fonts] ${name}: ${err instanceof Error ? err.message : err}`)
    failed = true
  }
}

if (failed) process.exit(1)
