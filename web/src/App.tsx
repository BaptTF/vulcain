import { useCallback, useEffect, useRef, useState } from 'react'
import { Toaster } from 'sonner'
import { getMeta, setTheme, type Meta } from './api'
import { type Tab } from './components/EditorPane'
import WorkspaceModal from './components/WorkspaceModal'
import WorkspaceSwitcher from './components/WorkspaceSwitcher'
import Workbench, { PANE_IDS, type PaneId, type WorkbenchHandle } from './components/Workbench'

type SavedTabs = { tabs: string[]; active: string | null }

function storedWorkspace(): string {
  try {
    return localStorage.getItem('vulcain.ws') ?? ''
  } catch {
    return ''
  }
}

function tabsKey(ws: string): string {
  return `vulcain.tabs.${ws}`
}

function readSavedTabs(ws: string): SavedTabs {
  if (!ws) return { tabs: [], active: null }
  try {
    const raw = localStorage.getItem(tabsKey(ws))
    if (!raw) return { tabs: [], active: null }
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed?.tabs)) return { tabs: [], active: null }
    const paths = parsed.tabs.filter((p: unknown): p is string => typeof p === 'string')
    const active =
      typeof parsed.active === 'string' && paths.includes(parsed.active)
        ? parsed.active
        : (paths[0] ?? null)
    return { tabs: paths, active }
  } catch {
    return { tabs: [], active: null }
  }
}

function persistTabs(ws: string, tabs: Tab[], active: string | null): void {
  if (!ws) return
  try {
    localStorage.setItem(tabsKey(ws), JSON.stringify({ tabs: tabs.map(t => t.path), active }))
  } catch {}
}

function tabsFromSaved(saved: SavedTabs): Tab[] {
  return saved.tabs.map(p => ({ path: p }))
}

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null)
  const [activeWs, setActiveWs] = useState<string>(() => storedWorkspace())
  const [tabs, setTabs] = useState<Tab[]>(() => tabsFromSaved(readSavedTabs(storedWorkspace())))
  const [activeTab, setActiveTab] = useState<string | null>(() => readSavedTabs(storedWorkspace()).active)
  const [wsModalOpen, setWsModalOpen] = useState(false)
  const flushRef = useRef<(() => void) | null>(null)
  const workbenchRef = useRef<WorkbenchHandle>(null)

  const [panes, setPanes] = useState<Record<PaneId, boolean>>(() => {
    try {
      const raw = localStorage.getItem('vulcain.panes')
      if (raw) {
        const saved = JSON.parse(raw)
        if (saved && typeof saved === 'object') {
          return { tree: true, editor: true, preview: true, agent: true, ...saved }
        }
      }
    } catch {}
    return { tree: true, editor: true, preview: true, agent: true }
  })

  const togglePane = useCallback((id: PaneId) => {
    workbenchRef.current?.togglePane(id)
  }, [])

  const applyWorkspace = useCallback((name: string, persistFrom?: { ws: string; tabs: Tab[]; active: string | null }) => {
    if (!name) return
    if (persistFrom?.ws && persistFrom.ws !== name) {
      flushRef.current?.()
      persistTabs(persistFrom.ws, persistFrom.tabs, persistFrom.active)
    }
    const saved = readSavedTabs(name)
    setActiveWs(name)
    setTabs(tabsFromSaved(saved))
    setActiveTab(saved.active)
  }, [])

  useEffect(() => {
    getMeta().then(m => {
      setMeta(m)
      if (!localStorage.getItem('vulcain.ws')) {
        applyWorkspace(m.defaultWorkspace)
        if (m.defaultWorkspace === '__config__') setWsModalOpen(true)
      }
    })
  }, [applyWorkspace])

  useEffect(() => {
    document.documentElement.dataset.theme = meta?.theme ?? 'dark'
  }, [meta?.theme])

  useEffect(() => {
    try {
      localStorage.setItem('vulcain.panes', JSON.stringify(panes))
    } catch {}
  }, [panes])

  useEffect(() => {
    if (activeWs) localStorage.setItem('vulcain.ws', activeWs)
  }, [activeWs])

  useEffect(() => {
    persistTabs(activeWs, tabs, activeTab)
  }, [tabs, activeTab, activeWs])

  const openFile = useCallback((path: string) => {
    setTabs(prev => {
      if (prev.some(t => t.path === path)) return prev
      return [...prev, { path }]
    })
    setActiveTab(path)
  }, [])

  const closeTab = useCallback((path: string) => {
    setTabs(prev => {
      const next = prev.filter(t => t.path !== path)
      return next
    })
    setActiveTab(cur => (cur === path ? null : cur))
  }, [])

  const toggleTheme = useCallback(async () => {
    if (!meta) return
    const next = meta.theme === 'dark' ? 'light' : 'dark'
    setMeta({ ...meta, theme: next })
    try {
      await setTheme(next)
    } catch {}
  }, [meta])

  const isConfigWs = activeWs === '__config__'

  const selectWorkspace = useCallback((name: string) => {
    if (name !== activeWs) applyWorkspace(name, { ws: activeWs, tabs, active: activeTab })
    getMeta().then(setMeta).catch(() => {})
  }, [applyWorkspace, activeWs, tabs, activeTab])

  return (
    <div className="app">
      <Toaster
        theme={meta?.theme === 'light' ? 'light' : 'dark'}
        position="bottom-right"
        richColors
        closeButton
      />
      <header className="topbar">
        <span className="logo">VULCAIN</span>
        <WorkspaceSwitcher activeWs={activeWs} onSelect={selectWorkspace} onOpenFolder={() => setWsModalOpen(true)} />
        <div className="spacer" />
        {isConfigWs && <span style={{ color: 'var(--muted)' }}>workspace configuration globale</span>}
        <button className="btn" onClick={toggleTheme} title="Basculer le theme">
          {meta?.theme === 'light' ? 'Dark' : 'Light'}
        </button>
      </header>

      <div className="viewbar">
        {PANE_IDS.map(id => (
          <button
            key={id}
            className={`pane-toggle${panes[id] ? ' active' : ''}`}
            onClick={() => togglePane(id)}
            title={panes[id] ? `Masquer ${id}` : `Afficher ${id}`}
          >
            {id === 'tree' ? 'Tree' : id === 'editor' ? 'Editor' : id === 'preview' ? 'Preview' : 'Agent'}
          </button>
        ))}
      </div>

      <div className="main-panels">
        <Workbench
          ref={workbenchRef}
          ws={activeWs}
          theme={meta?.theme ?? 'dark'}
          panes={panes}
          onPanesChange={setPanes}
          tabs={tabs}
          activePath={activeTab}
          onActivate={setActiveTab}
          onClose={closeTab}
          onOpen={openFile}
          flushRef={flushRef}
        />
      </div>
      <WorkspaceModal
        open={wsModalOpen}
        onSelect={selectWorkspace}
        onClose={() => setWsModalOpen(false)}
      />
    </div>
  )
}
