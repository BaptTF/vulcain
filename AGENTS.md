# AGENTS.md

Guidance for AI agents and contributors working on the Vulcain codebase.

## What is Vulcain

Vulcain is a minimal web note-taking editor:

- **Markdown notes** (Obsidian-style) with a **PDF export** via Typst (WASM in the browser).
- An **AI agent** wired in through pi's in-process SDK (`@earendil-works/pi-coding-agent`, `createAgentSession`) with a Vercel-AI-SDK streamed chat surfaced by assistant-ui.
- **Web search** via an agentic search layer in the pi extension (SearXNG metasearch self-hosted, optional Tavily) + **stealth browsing** via [camofox](https://github.com/jo-inc/camofox-browser) for protected sites.

```
File tree │ CodeMirror 6 editor (+ md/typst preview, PDF export) │ Agent chat (assistant-ui)
```

## Repository layout

| Path | Role |
|---|---|
| `web/` | React + Vite frontend: react-arborist, CodeMirror 6, react-resizable-panels, markdown-it + DOMPurify + highlight.js, Typst.ts WASM. Chat = assistant-ui primitives (`web/src/components/assistant-ui/`) + `useChatRuntime` (Vercel AI SDK) sur `POST /api/chat`. |
| `server/` | Fastify backend: workspace-jailed fs API, chokidar → WS, chat = pi **in-process** (`server/src/chat.ts` : `createAgentSession` par workspace, événements pi traduits en flux « UI message stream »). |
| `pi-ext/` | TypeScript extension for pi (jiti, no compilation) exposing extra tools (`web_search`, `web_research`, `web_read`, `browser_*`, `browser_screenshot`). Copied as a directory to `~/.pi/agent/extensions/vulcain-tools/`. |
| `scripts/` | Bootstrap and build helpers. |
| `test/` | E2e tests for the chat API and watcher (`node test/e2e.mjs`, requires a running server). Search-provider tests run standalone (`node test/web-search.mjs`). `test/ui` for UI tests. |
| `docker/` | Dockerfile + compose. |
| `.github/workflows/` | CI/CD (Docker build/push to ghcr.io). |

## Commands

```bash
npm install
npm run bootstrap        # scaffold ~/.vulcain/config/config.json + skills/, install pi extension
npm run build            # build pi-ext, server, web
npm run dev              # server :7331 + vite :5173 (open http://localhost:5173)
npm run lint             # eslint .
```

### Tests

The e2e test suite requires a running server (start it with the fake chat backend):

```bash
VULCAIN_HOME=/tmp/vulcain-test node scripts/bootstrap.mjs
VULCAIN_HOME=/tmp/vulcain-test VULCAIN_CHAT_BACKEND=fake PI_CODING_AGENT_DIR=/tmp/vulcain-test-pi VULCAIN_PORT=7391 node server/dist/index.js &
PI_CODING_AGENT_DIR=/tmp/vulcain-test-pi node test/e2e.mjs   # 18 checks: watch + /api/chat streaming/tool_call/commands/reset + SYSTEM.md sync
node test/web-search.mjs                                      # 19 checks: SearXNG/Tavily parsing, parallel+deep research, cache, camofox fallback
```

`VULCAIN_CHAT_BACKEND=fake` selects a scripted in-process chat backend (echo + tool call) so tests run without a real pi/LLM. Without it, the server uses the real pi SDK in-process.

### UI tests (`test/ui/ui.spec.mjs`)

The UI suite drives a real Chromium via Playwright and needs the app served
plus the fake chat backend (`VULCAIN_CHAT_BACKEND=fake`). It covers the editor (open, content,
**autosave on typing**, **open-tab restoration across reload**), file tree, chat and
workspace switcher.

- **Native (fast path, when Chromium deps are available):** the runner bootstraps an
  isolated env, starts the server (serves `web/dist` + API on one port) and runs the spec:

  ```bash
  npm run test:ui     # node scripts/test-ui.mjs (VULCAIN_PORT / BASE_URL overridable)
  ```

- **Docker (self-contained, works on hosts lacking Chromium libs, e.g. NixOS):**
  `docker/Dockerfile.test` installs Playwright + Chromium deps and runs the same script:

  ```bash
  npm run test:ui:docker   # builds vulcain-test image then runs it
  ```

  `scripts/test-ui.mjs` is the single source of truth for the test setup: fresh
  `VULCAIN_HOME`, `agent.command` pointed at the fake agent, a `Notes` workspace
  with `welcome.md`, then server + spec. UI tests are run in CI-equivalent Docker
  when Chromium isn't installed locally.

## Project rules

These rules apply to every contribution. Violations are treated as review blockers.

1. **Reuse open-source components — never reinvent the wheel.**
   Prefer battle-tested, existing open-source libraries over hand-rolled implementations. Before writing new code, check whether an existing dependency or a well-established OSS package already solves the problem. New dependencies must be justified and, when possible, already maintained and widely adopted.

2. **Use Conventional Commits.**
   Every commit message must follow the [Conventional Commits](https://www.conventionalcommits.org/) spec: `type(scope): subject`, e.g. `feat(server): add workspace fs API`, `fix(web): stream tool calls`, `chore: bump deps`. Common types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `build`, `ci`, `style`.

3. **Respect the DRY principle.**
   Do not repeat yourself. Extract shared logic into reusable modules/functions instead of duplicating code. If a pattern appears a second time, refactor it into a shared helper. Keep the single source of truth (e.g. config lives in `~/.vulcain/config.json`) and reference it rather than duplicating values.

4. **Test your changes.**
   Any functional change must be accompanied by tests. The project uses `node test/e2e.mjs` (requires a running server) for backend/bridge coverage, `node test/web-search.mjs` for the search providers/research orchestration, and `test/ui` for the frontend. Update existing tests and add new ones covering the changed behavior. Run `npm run lint` and the test suite before finishing.

## Conventions

- **No processes from the browser**: the browser cannot spawn processes, so the chat runs through the server. pi is embedded **in-process** (`createAgentSession`); `POST /api/chat` streams pi events as the Vercel AI SDK "UI message stream" (SSE), consumed by assistant-ui's `useChatRuntime`. The server keeps one `AgentSession` per workspace (`server/src/chat.ts`).
- **Config is the single source of truth**: `~/.vulcain/config.json`. Server only touches configured workspace roots plus the config workspace. `agent.systemPrompt` (path to a `SYSTEM.md`, default `<configWorkspace>/SYSTEM.md`) is synced to `~/.pi/agent/SYSTEM.md` at boot so pi replaces its default coding-agent prompt for the chat.
- **Environment**: `VULCAIN_HOME`, `VULCAIN_PORT`, `PI_CODING_AGENT_DIR` and `VULCAIN_WORKSPACES` override the home dir, port, pi agent dir and workspace root for isolated test runs. `VULCAIN_CHAT_BACKEND=fake` swaps in a scripted chat backend (echo + tool call) for tests.
- **TypeScript** across the repo; the chat wire types live in `server/src/chat.ts`.
