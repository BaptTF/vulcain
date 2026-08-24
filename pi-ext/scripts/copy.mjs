#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dest = path.join(here, '..', 'dist')
fs.mkdirSync(dest, { recursive: true })
fs.copyFileSync(path.join(here, '..', 'src', 'vulcain-tools.ts'), path.join(dest, 'vulcain-tools.ts'))
console.log('[pi-ext] copied vulcain-tools.ts -> dist/')
