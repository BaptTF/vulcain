#!/usr/bin/env node
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const vulcainHome = process.env.VULCAIN_HOME || path.join(os.homedir(), '.vulcain')
const configDir = path.join(vulcainHome, 'config')
const skillsDir = path.join(configDir, 'skills')
const configPath = path.join(configDir, 'config.json')
const defaultWsPath = process.env.VULCAIN_WORKSPACES || path.join(vulcainHome, 'workspaces')
const notesWs = path.join(defaultWsPath, 'notes')
const systemPromptPath = path.join(configDir, 'SYSTEM.md')

const DEFAULT_SYSTEM_PROMPT = `You are an assistant embedded in Vulcain, a markdown note-taking app. You help the user with general tasks such as web research, fact-checking, summarization, drafting and answering questions — you are not a code editor.

- Use the available tools (web_search, web_research, web_read, browser_*, etc.) when they would help answer accurately.
- For multi-angle questions, use web_research with subQueries to search in parallel.
- When you search the web or browse, cite your sources.
- Be concise, clear and write in the language the user writes in.
`

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

ensureDir(skillsDir)
ensureDir(notesWs)

if (!fs.existsSync(systemPromptPath)) {
  fs.writeFileSync(systemPromptPath, DEFAULT_SYSTEM_PROMPT)
  console.log(`[bootstrap] wrote ${systemPromptPath}`)
}

if (!fs.existsSync(configPath)) {
  const cfg = {
    theme: 'dark',
    server: { host: '127.0.0.1', port: 7331 },
    workspaces: [{ name: 'Notes', path: notesWs.replace(os.homedir(), '~') }],
    configWorkspace: configDir.replace(os.homedir(), '~'),
    llm: {
      provider: {
        name: 'bifrost',
        baseUrl: 'https://bifrost/v1',
        api: 'openai-completions',
        apiKey: '-',
        models: [
          {
            id: 'us.anthropic.claude-sonnet-4-6',
            name: 'Claude Sonnet 4.6 (Bifrost)',
            reasoning: true,
            input: ['text', 'image'],
            contextWindow: 200000,
            maxTokens: 64000
          }
        ]
      }
    },
    agent: { command: [process.env.VULCAIN_AGENT_CMD || 'pi-acp'], args: [], systemPrompt: systemPromptPath.replace(os.homedir(), '~') },
    tools: {
      camofox: { baseUrl: process.env.VULCAIN_CAMOFOX_URL || 'http://camofox:9377', accessKey: '' },
      webSearch: {
        provider: 'searxng',
        baseUrl: process.env.VULCAIN_SEARXNG_URL || 'http://127.0.0.1:8080',
        engines: 'bing,duckduckgo,startpage,brave,wikipedia',
        maxResults: 6
      },
      webRead: { method: 'auto' },
      research: { depth: 'quick', maxSources: 3, cacheTtlMinutes: 30, saveToNote: false }
    }
  }
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n')
  console.log(`[bootstrap] wrote ${configPath}`)
}

const agentsSkills = path.join(os.homedir(), '.agents', 'skills')
if (!fs.existsSync(agentsSkills) && !fs.existsSync(path.join(os.homedir(), '.agents'))) {
  ensureDir(path.join(os.homedir(), '.agents'))
  fs.symlinkSync(skillsDir, agentsSkills)
  console.log(`[bootstrap] symlinked ${agentsSkills} -> ${skillsDir}`)
} else if (fs.lstatSync(agentsSkills).isSymbolicLink()) {
  console.log('[bootstrap] ~/.agents/skills symlink already present')
} else {
  console.log('[bootstrap] ~/.agents/skills already exists as real dir, leaving untouched')
}

const welcome = path.join(notesWs, 'welcome.md')
if (!fs.existsSync(welcome)) {
  fs.writeFileSync(
    welcome,
    `# Bienvenue dans Vulcain\n\n- Créez des notes en **markdown**, la preview est dans la barre d'onglets.\n- Créez un fichier \`.typ\` pour écrire du Typst et exporter des PDF propres.\n- Le chat à droite parle à votre agent pi (configuré via bifrost).\n`
  )
}
const exampleTyp = path.join(notesWs, 'exemple.typ')
if (!fs.existsSync(exampleTyp)) {
  fs.writeFileSync(
    exampleTyp,
    `= Mon premier document\n\nCeci est un document *Typst* compilé _directement dans le navigateur_.\n\n== Liste\n- Rapide\n- Propre\n- PDF en un clic\n\n$ integral_0^1 x^2 dif x = 1/3 $\n`
  )
}

const piAgentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent')
const piExtDir = path.join(piAgentDir, 'extensions')
ensureDir(piExtDir)

const settingsPath = path.join(piAgentDir, 'settings.json')
let piSettings = {}
try {
  piSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
} catch {}
if (piSettings.defaultProjectTrust !== 'always') {
  piSettings.defaultProjectTrust = 'always'
  fs.writeFileSync(settingsPath, JSON.stringify(piSettings, null, 2) + '\n')
  console.log('[bootstrap] pi settings: defaultProjectTrust=always (.agents skills des workspaces actifs)')
}

const builtExt = path.join(repoRoot, 'pi-ext', 'dist', 'vulcain-tools')
const extDestDir = path.join(piExtDir, 'vulcain-tools')
if (fs.existsSync(builtExt)) {
  fs.rmSync(extDestDir, { recursive: true, force: true })
  fs.cpSync(builtExt, extDestDir, { recursive: true })
  console.log('[bootstrap] installed pi extension -> ' + extDestDir)
  fs.rmSync(path.join(piExtDir, 'vulcain-tools.ts'), { force: true })
  console.log('[bootstrap] removed legacy extension file vulcain-tools.ts')
} else {
  console.log('[bootstrap] pi-ext not built yet, run: npm run build -w pi-ext')
}

if (process.argv.includes('--install-pi')) {
  try {
    execSync('pi --version', { stdio: 'ignore' })
    console.log('[bootstrap] pi already installed')
  } catch {
    console.log('[bootstrap] installing @earendil-works/pi-coding-agent globally...')
    execSync('npm install -g --ignore-scripts @earendil-works/pi-coding-agent pi-acp', { stdio: 'inherit' })
  }
}

console.log('[bootstrap] done')
