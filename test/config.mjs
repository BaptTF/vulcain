import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vulcain-config-'))
process.env.VULCAIN_HOME = HOME
fs.mkdirSync(path.join(HOME, 'config'), { recursive: true })

const {
  loadConfig,
  saveConfig,
  resetConfigCache,
  configPath,
  lastGoodConfigPath
} = await import('../server/src/config.ts')
const { loadVulcainConfig } = await import('../pi-ext/src/providers.ts')

const results = []
function check(name, cond) {
  results.push([name, cond])
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`)
}

function writeConfig(text) {
  fs.writeFileSync(configPath(), text)
}

const valid = {
  theme: 'light',
  server: { host: '127.0.0.1', port: 7331 },
  workspaces: [{ name: 'Notes', path: '/tmp/notes' }],
  configWorkspace: path.join(HOME, 'config'),
  agent: {},
  tools: { camofox: { baseUrl: 'http://camofox.test' } },
  llm: { provider: { name: 'bifrost' } }
}

writeConfig(JSON.stringify(valid, null, 2) + '\n')
const first = loadConfig()
check('load: reads valid config.json', first.theme === 'light' && first.workspaces[0]?.name === 'Notes')
check('load: snapshots last-good next to vulcain home', fs.existsSync(lastGoodConfigPath()))

writeConfig('{\n  "theme": "light",\n  "workspaces": [\n')
const broken = loadConfig()
check('load: broken JSON keeps last good in-process', broken.theme === 'light' && broken.workspaces[0]?.name === 'Notes' && broken.llm?.provider?.name === 'bifrost')
check('load: broken JSON does not rewrite config.json', fs.readFileSync(configPath(), 'utf8').includes('"workspaces": ['))

resetConfigCache()
const afterRestart = loadConfig()
check('load: process restart falls back to last-good file', afterRestart.theme === 'light' && afterRestart.workspaces[0]?.name === 'Notes')

const toolsFromBroken = loadVulcainConfig()
check('pi-ext: broken JSON falls back to last-good tools', toolsFromBroken.tools?.camofox?.baseUrl === 'http://camofox.test')

fs.unlinkSync(lastGoodConfigPath())
resetConfigCache()
const defaults = loadConfig()
check('load: broken JSON with no last-good uses defaults without throwing', defaults.theme === 'dark' && Array.isArray(defaults.workspaces) && defaults.workspaces.length === 0)

writeConfig(JSON.stringify(valid, null, 2) + '\n')
resetConfigCache()
loadConfig()
const saved = loadConfig()
saved.theme = 'dark'
saveConfig(saved)
check('save: writes valid config.json', JSON.parse(fs.readFileSync(configPath(), 'utf8')).theme === 'dark')
check('save: refreshes last-good snapshot', JSON.parse(fs.readFileSync(lastGoodConfigPath(), 'utf8')).theme === 'dark')

writeConfig('[]')
resetConfigCache()
fs.writeFileSync(lastGoodConfigPath(), JSON.stringify(valid) + '\n')
const nonObject = loadConfig()
check('load: non-object JSON uses last-good', nonObject.theme === 'light' && nonObject.workspaces[0]?.name === 'Notes')

fs.rmSync(HOME, { recursive: true, force: true })

const failed = results.filter(r => !r[1])
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
