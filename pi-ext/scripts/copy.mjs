#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dest = path.join(here, '..', 'dist')
fs.rmSync(dest, { recursive: true, force: true })
fs.mkdirSync(dest, { recursive: true })
fs.cpSync(path.join(here, '..', 'src'), path.join(dest, 'vulcain-tools'), { recursive: true })
console.log('[pi-ext] copied src/ -> dist/vulcain-tools/')