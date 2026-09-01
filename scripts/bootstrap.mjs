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

const DEFAULT_SYSTEM_PROMPT = `You are an assistant embedded in Vulcain, a markdown note-taking app. You help with web research, fact-checking, summarization, drafting and answering questions — you are not a code editor.

# Research methodology
When a question needs information that is not certain or current, research it instead of answering from memory:
- **Plan first.** Break the question into its angles and pick queries that cover them.
- **Go parallel.** Fire 4+ \`web_search\` calls at once, or better use \`web_research\` with \`depth=deep\` and 4+ \`subQueries\`. Batched tool calls run in parallel.
- **Read, don't skim.** Open the top 5+ sources with \`web_read\` to ground the answer in real content, not just snippets.
- **Iterate.** Run follow-up searches for anything still unclear or contradicted, until every angle is covered.
- **Cross-check.** Facts that matter should be confirmed by at least 2 independent sources; flag disagreement when sources conflict.

# Tool guidance
- \`web_search(query, ...)\` — a single search. Use it for a quick fact or one angle.
- \`web_research(topic, subQueries, depth="deep", maxSources)\` — multi-query research that merges, dedupes and (with deep) extracts sources into a sourced brief. Prefer it for open questions.
- \`web_read(url)\` — extract a page's text to verify a source.
- \`engines\` — you may pick a subset of the configured engines when it helps: \`wikipedia\` for definitions, category \`news\` (e.g. \`bing news\`, \`reuters\`) for current events, category \`science\` (e.g. \`arxiv\`, \`pubmed\`) for academic topics.
- \`browser_*\` — full browser control when you must click, scroll or bypass a simple page; prefer \`web_read\`/\`web_search\` otherwise.

# Rules
- Never answer from a single snippet alone.
- Cite your sources (URLs) in every research answer.
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
            id: 'opencode-go/deepseek-v4-flash',
            name: 'Deepseek v4 Flash',
            reasoning: true,
            input: ['text'],
            contextWindow: 200000,
            maxTokens: 64000
          }
        ]
      }
    },
    agent: { systemPrompt: systemPromptPath.replace(os.homedir(), '~') },
    tools: {
      camofox: { baseUrl: process.env.VULCAIN_CAMOFOX_URL || 'http://camofox:9377', accessKey: '' },
      webSearch: {
        provider: 'searxng',
        baseUrl: process.env.VULCAIN_SEARXNG_URL || 'http://127.0.0.1:8080',
        engines: 'google,bing,brave,wikipedia',
        maxResults: 10
      },
      webRead: { method: 'auto' },
      research: { depth: 'deep', maxSources: 6, cacheTtlMinutes: 30, saveToNote: false }
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
    execSync('npm install -g --ignore-scripts @earendil-works/pi-coding-agent', { stdio: 'inherit' })
  }
}

console.log('[bootstrap] done')
