import { useCallback, useEffect, useRef, useState } from 'react'
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { Toaster } from 'sonner'
import { getMeta, setTheme, type Meta } from './api'
import FileTree from './components/FileTree'
import EditorPane, { type Tab } from './components/EditorPane'
import Chat from './components/Chat'
import WorkspaceModal from './components/WorkspaceModal'
import WorkspaceSwitcher from './components/WorkspaceSwitcher'

type PaneId = 'tree' | 'editor' | 'preview' | 'agent'

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null)
  const [activeWs, setActiveWs] = useState<string>(() => localStorage.getItem('vulcain.ws') ?? '')
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(null)
  const [restored, setRestored] = useState(false)
  const [wsModalOpen, setWsModalOpen] = useState(false)
  const flushRef = useRef<(() => void) | null>(null)
  const activeWsRef = useRef(activeWs)
  activeWsRef.current = activeWs

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
    setPanes(prev => ({ ...prev, [id]: !prev[id] }))
  }, [])

  const centerVisible = panes.editor || panes.preview
  const outerPanelIds = ['tree', ...(centerVisible ? ['center'] : []), ...(panes.agent ? ['agent'] : [])]
  const { defaultLayout: outerLayout, onLayoutChanged: onOuterLayoutChanged } = useDefaultLayout({
    id: 'vulcain.outer',
    panelIds: outerPanelIds
  })

  const tabsKey = (ws: string) => `vulcain.tabs.${ws}`
  const readSaved = useCallback((ws: string): { tabs: string[]; active: string | null } => {
    try {
      const raw = localStorage.getItem(`vulcain.tabs.${ws}`)
      if (!raw) return { tabs: [], active: null }
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed.tabs) && typeof parsed.active === 'string') {
        return { tabs: parsed.tabs as string[], active: parsed.active }
      }
    } catch {}
    return { tabs: [], active: null }
  }, [])

  const restoreTabs = useCallback(
    (ws: string) => {
      const saved = readSaved(ws)
      setTabs(saved.tabs.map(p => ({ path: p })))
      setActiveTab(saved.active)
    },
    [readSaved]
  )

  useEffect(() => {
    getMeta().then(m => {
      setMeta(m)
      if (!localStorage.getItem('vulcain.ws')) {
        setActiveWs(m.defaultWorkspace)
        if (m.defaultWorkspace === '__config__') setWsModalOpen(true)
      }
    })
  }, [])

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
    if (!restored) return
    try {
      localStorage.setItem(
        tabsKey(activeWs),
        JSON.stringify({ tabs: tabs.map(t => t.path), active: activeTab })
      )
    } catch {}
  }, [tabs, activeTab, activeWs, restored, tabsKey])

  useEffect(() => {
    if (activeWsRef.current && activeWsRef.current !== activeWs) flushRef.current?.()
    setRestored(false)
    restoreTabs(activeWs)
    setRestored(true)
  }, [activeWs, restoreTabs])

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
    setActiveWs(name)
    getMeta().then(setMeta).catch(() => {})
  }, [])

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
        {(['tree', 'editor', 'preview', 'agent'] as PaneId[]).map(id => (
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
        <Group
          orientation="horizontal"
          id="vulcain.outer"
          defaultLayout={outerLayout}
          onLayoutChanged={onOuterLayoutChanged}
        >
          {panes.tree && (
            <Panel id="tree" minSize="12" defaultSize="20">
              <div className="panel-tree">
                <FileTree ws={activeWs} onOpen={openFile} />
              </div>
            </Panel>
          )}
          {panes.tree && centerVisible && <Separator />}
          {centerVisible && (
            <Panel id="center" minSize="10">
              <div className="panel-center">
                <EditorPane
                  ws={activeWs}
                  tabs={tabs}
                  activePath={activeTab}
                  onActivate={setActiveTab}
                  onClose={closeTab}
                  flushRef={flushRef}
                  showEditor={panes.editor}
                  showPreview={panes.preview}
                />
              </div>
            </Panel>
          )}
          {centerVisible && panes.agent && <Separator />}
          {panes.agent && (
            <Panel id="agent" minSize="16" defaultSize="28">
              <Chat ws={activeWs} onOpenFile={openFile} />
            </Panel>
          )}
        </Group>
      </div>
      <WorkspaceModal
        open={wsModalOpen}
        onSelect={selectWorkspace}
        onClose={() => setWsModalOpen(false)}
      />
    </div>
  )
}
