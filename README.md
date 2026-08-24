# Vulcain

Éditeur de notes web minimaliste : markdown (façon Obsidian) + PDF propres via Typst, avec un agent IA branché par ACP ([pi](https://github.com/earendil-works/pi) via l'adaptateur `pi-acp`), recherche web et navigateur stealth ([camofox](https://github.com/jo-inc/camofox-browser)).

```
Arbre fichiers │ Éditeur CodeMirror 6 (+ preview md/typst, export PDF) │ Chat agent (ACP)
```

## Démarrage rapide (dev)

```bash
npm install
npm run bootstrap        # crée ~/.vulcain/config/config.json + skills/, installe l'extension pi
npm run build -w pi-ext  # copie l'extension pi
npm run bootstrap        # ré-installe l'extension fraîchement construite
npm run dev              # serveur :7331 + vite :5173 (ouvrir http://localhost:5173)
```

Installer pi et s'authentifier une fois (ou passer `--install-pi` au bootstrap) :

```bash
npm i -g --ignore-scripts @earendil-works/pi-coding-agent pi-acp
pi   # /login pour choisir un provider (ou utiliser bifrost, voir config)
```

La config LLM (`llm.provider` dans config.json) est synchronisée vers `~/.pi/agent/models.json` à chaque démarrage du serveur. Par défaut : passerelle [bifrost](https://github.com/maximhq/bifrost) OpenAI-compatible sur le tailnet, sans clé.

## Docker

```bash
cd docker
docker compose up --build -d     # http://localhost:7331
```

Volumes persistants : `/data/workspaces` (notes), `/data/.vulcain` (config), `/data/.pi` (sessions/auth pi). pi et pi-acp sont embarqués dans l'image ; aucun appel réseau au démarrage.

Point camofox depuis le conteneur : mettre dans config.json `tools.camofox.baseUrl` (ex. `http://host.docker.internal:9377` si exposé sur l'hôte).

## Configuration — `~/.vulcain/config.json`

Source de vérité unique. Le bouton **Config** de la topbar ouvre ce dossier comme un workspace normal (config.json éditable + dossier `skills/`).

| Clé | Rôle |
|---|---|
| `theme` | `dark` \| `light` (bouton de bascule dans la topbar) |
| `workspaces` | liste `{name, path}` — le serveur ne touche QUE ces racines (+ workspace config) |
| `configWorkspace` | chemin du dossier ouvert par le bouton Config |
| `llm.provider` | génère `~/.pi/agent/models.json` au boot (baseUrl/api/apiKey/models) |
| `agent.command` | commande ACP spawnée par session chat, cwd = racine du workspace. Remplaçable par n'importe quel agent ACP (ex. `["npx","-y","@zed-industries/claude-agent-acp"]`) |
| `tools.camofox` | URL REST du navigateur stealth + accessKey optionnelle |
| `tools.webSearch` | provider de recherche (`camofox-macro` avec `@google_search` par défaut) |

## Skills

Format standard [agentskills.io](https://agentskills.io), chargés nativement par pi :

- **Globaux** : `~/.vulcain/config/skills/<nom>/SKILL.md` — le bootstrap symlink `~/.agents/skills` dessus.
- **Par workspace** : `<workspace>/.agents/skills/<nom>/SKILL.md`.

## Outils ajoutés à pi (extension vulcain-tools)

Installée dans `~/.pi/agent/extensions/vulcain-tools.ts`, lit la config Vulcain au runtime :

- `web_search(query)` — recherche Google via macro camofox, snapshot texte.
- `browser_open/navigate/click/type/scroll/snapshot/close` — pilotage du navigateur avec refs stables (e1, e2…).
- `browser_screenshot(tabId)` — PNG sauvé dans `<workspace>/.shots/`, chemin retourné au modèle.

## Architecture

```
web/    React + Vite : react-arborist · CodeMirror 6 · react-resizable-panels
        markdown-it+DOMPurify+highlight.js · Typst.ts WASM (compil + rendu + $typst.pdf local)
server/ Fastify : fs API jailée par workspace · chokidar→WS · pont WS⇄stdio `pi-acp`
        (transport pur JSON-RPC délimité \n — remplacer d'agent ne demande zéro code)
pi-ext/ extension TypeScript pour pi (jiti, pas de compilation)
test/   faux agent ACP + e2e du pont et du watcher (node test/e2e.mjs, serveur requis)
```

Le navigateur ne peut pas spawner de processus : le pont WS⇄stdio est donc inévitable ; il est volontairement stupide (il ne comprend pas le protocole, il ne casse jamais). Toute l'intelligence du protocole vit côté front (`web/src/acp.ts`, sous-set typé d'ACP).

## Tests

```bash
VULCAIN_HOME=/tmp/vulcain-test node scripts/bootstrap.mjs
# pointer cfg.agent.command vers ["node", "<repo>/test/fake-agent.mjs"]
VULCAIN_HOME=/tmp/vulcain-test VULCAIN_PORT=7391 node server/dist/index.js &
node test/e2e.mjs   # 8 checks : watch + initialize/session/prompt/streaming/tool_call
```
