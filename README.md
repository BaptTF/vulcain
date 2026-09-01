# Vulcain

Éditeur de notes web minimaliste : markdown (façon Obsidian) + PDF propres via Typst, avec un agent IA [pi](https://github.com/earendil-works/pi) embarqué (chat assistant-ui), recherche web et navigateur stealth ([camofox](https://github.com/jo-inc/camofox-browser)).

```
Arbre fichiers │ Éditeur CodeMirror 6 (+ preview md/typst, export PDF) │ Chat agent (assistant-ui)
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
npm i -g --ignore-scripts @earendil-works/pi-coding-agent
pi   # /login pour choisir un provider (ou utiliser bifrost, voir config)
```

La config LLM (`llm.provider` dans config.json) est synchronisée vers `~/.pi/agent/models.json` à chaque démarrage du serveur. Par défaut : passerelle [bifrost](https://github.com/maximhq/bifrost) OpenAI-compatible sur le tailnet, sans clé.

## Docker

```bash
cd docker
docker compose up --build -d     # http://localhost:7331
```

Volumes persistants : `/data/workspaces` (notes), `/data/.vulcain` (config), `/data/.pi` (sessions/auth pi). pi est embarqué dans l'image ; aucun appel réseau au démarrage.

Point camofox depuis le conteneur : mettre dans config.json `tools.camofox.baseUrl` (ex. `http://host.docker.internal:9377` si exposé sur l'hôte).

## Configuration — `~/.vulcain/config.json`

Source de vérité unique. Le bouton **Config** de la topbar ouvre ce dossier comme un workspace normal (config.json éditable + dossier `skills/`).

| Clé | Rôle |
|---|---|
| `theme` | `dark` \| `light` (bouton de bascule dans la topbar) |
| `workspaces` | liste `{name, path}` — le serveur ne touche QUE ces racines (+ workspace config) |
| `configWorkspace` | chemin du dossier ouvert par le bouton Config |
| `llm.provider` | génère `~/.pi/agent/models.json` au boot (baseUrl/api/apiKey/models) |
| `agent.systemPrompt` | chemin vers le `SYSTEM.md` du système (défaut : `<configWorkspace>/SYSTEM.md`). Synchronisé vers `~/.pi/agent/SYSTEM.md` au boot, pour remplacer le system prompt par défaut « coding agent » de pi |
| `tools.camofox` | URL REST du navigateur stealth + accessKey optionnelle |
| `tools.webSearch` | provider de recherche (`camofox-macro` avec `@google_search` par défaut) |

## System prompt du chat

Par défaut pi se comporte en agent de codage. Pour en faire un assistant général (recherche web, vérification de faits, rédaction…), un `SYSTEM.md` vit dans le dossier config (`~/.vulcain/config/SYSTEM.md`, créé par le bootstrap s'il n'existe pas). Son contenu **remplace** le system prompt par défaut de pi (les outils, skills et contextes restent ajoutés par pi après).

Le chemin de ce fichier est configurable via `agent.systemPrompt` dans `config.json`. Le serveur le synchronise vers `~/.pi/agent/SYSTEM.md` (emplacement global lu par pi) au démarrage. Supprimer le fichier (ou retirer `agent.systemPrompt`) rétablit le comportement par défaut de pi.

## Skills

Format standard [agentskills.io](https://agentskills.io), chargés nativement par pi :

- **Globaux** : `~/.vulcain/config/skills/<nom>/SKILL.md` — le bootstrap symlink `~/.agents/skills` dessus.
- **Par workspace** : `<workspace>/.agents/skills/<nom>/SKILL.md`.

## Outils ajoutés à pi (extension vulcain-tools)

Installée dans `~/.pi/agent/extensions/vulcain-tools/` (dossier, jiti), lit la config Vulcain au runtime :

- `web_search(query, category?, timeRange?, engines?, maxResults?)` — recherche web via le provider configuré (`tools.webSearch`). `timeRange` (day/week/month/year) est transmis à SearXNG et Tavily ; `engines` restreint à un sous-ensemble de l'allowlist config.
- `web_research(topic, subQueries?, depth?, maxSources?, category?, timeRange?, engines?, saveToNote?)` — recherche **agentique** : sous-requêtes en parallèle, fusion/dédoublonnage, brief markdown sourcé `[n]` ; `depth=deep` lit les top-sources ; `saveToNote` écrit `.research/<topic>.md`.
- `web_read(url)` — extraction rapide du contenu d'une page (Tavily extract si clé, sinon camofox). Retente une fois si le tab camofox a été tué (410).
- `browser_open/navigate/click/type/scroll/snapshot/close` — pilotage du navigateur stealth avec refs stables (e1, e2…) pour les pages protégées.
- `browser_screenshot(tabId)` — PNG sauvé dans `<workspace>/.shots/`, chemin retourné au modèle.

### Providers de recherche (`tools.webSearch`)

| provider | besoin | notes |
|---|---|---|
| `searxng` | `baseUrl` (ex. `http://searxng.openclaw.svc.cluster.local:8080`) | metasearch parallèle, gratuit, self-hosted |
| `tavily` | `apiKey` (free tier 1 000 req/mois) | search+extract en 1 appel, `topic`/`time_range` |
| `camofox-macro` | camofox | Google via navigateur stealth (fallback par défaut) |

Sans clé/baseUrl configuré, ou si le provider est injoignable, l'extension retombe sur `camofox-macro`. Autres réglages : `engines` (allowlist, ex. `google,bing,brave,wikipedia` — les engines bloqués par CAPTCHA type `duckduckgo`/`startpage` peuvent être retirés), `categories`, `maxResults` (défaut 10), `tools.webRead.method`, `tools.research.{depth (défaut deep),maxSources (défaut 6),cacheTtlMinutes,saveToNote}`. Overrides env : `TAVILY_API_KEY`, `VULCAIN_SEARXNG_URL`.

## Architecture

```
web/    React + Vite : react-arborist · CodeMirror 6 · react-resizable-panels
        markdown-it+DOMPurify+highlight.js · Typst.ts WASM (compil + rendu + $typst.pdf local)
        assistant-ui + Vercel AI SDK (chat) · ACP abandonné au profit du SDK pi in-process
server/ Fastify : fs API jailée par workspace · chokidar→WS · chat = pi in-process
        (createAgentSession → flux « UI message stream » sur POST /api/chat)
pi-ext/ extension TypeScript pour pi (jiti, pas de compilation)
test/   e2e du chat + watcher (node test/e2e.mjs, serveur requis) · test/ui (Playwright)
```

Le navigateur ne peut pas spawner de processus ; le chat passe donc par le serveur, qui embarque pi **in-process** via `@earendil-works/pi-coding-agent`. `POST /api/chat` reçoit les messages, fait tourner un `AgentSession` (une session par workspace) et streame les événements pi au format « UI message stream » du SDK Vercel AI, consommé côté front par assistant-ui (`useChatRuntime`).

## Tests

```bash
VULCAIN_HOME=/tmp/vulcain-test node scripts/bootstrap.mjs
VULCAIN_HOME=/tmp/vulcain-test VULCAIN_CHAT_BACKEND=fake PI_CODING_AGENT_DIR=/tmp/vulcain-test-pi VULCAIN_PORT=7391 node server/dist/index.js &
PI_CODING_AGENT_DIR=/tmp/vulcain-test-pi node test/e2e.mjs   # 18 checks : watch + /api/chat streaming/tool_call/commands/reset + sync SYSTEM.md
node test/web-search.mjs   # 19 checks : parsing SearXNG/Tavily, recherche parallèle + deep, cache, fallback camofox
```

`VULCAIN_CHAT_BACKEND=fake` branche un backend de chat scripté (echo + tool call) pour les tests ; sans cette variable, le serveur utilise le vrai pi in-process.
