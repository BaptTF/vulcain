import { useCallback, useEffect, useRef, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { Toaster } from 'sonner'
import { getMeta, setTheme, type Meta } from './api'
import FileTree from './components/FileTree'
import EditorPane, { type Tab } from './components/EditorPane'
import Chat from './components/Chat'
import WorkspaceModal from './components/WorkspaceModal'

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
        <button className="btn" onClick={() => setWsModalOpen(true)} title="Choisir / ajouter un workspace">
          {isConfigWs ? 'Config' : activeWs || '…'} ▾
        </button>
        <div className="spacer" />
        {isConfigWs && <span style={{ color: 'var(--muted)' }}>workspace configuration globale</span>}
        <button className="btn" onClick={toggleTheme} title="Basculer le theme">
          {meta?.theme === 'light' ? 'Dark' : 'Light'}
        </button>
      </header>

      <div className="main-panels">
        <PanelGroup direction="horizontal">
          <Panel defaultSize={20} minSize={12}>
            <div className="panel-tree">
              <FileTree ws={activeWs} onOpen={openFile} />
            </div>
          </Panel>
          <PanelResizeHandle />
          <Panel minSize={25}>
            <div className="panel-center">
              <EditorPane
                ws={activeWs}
                tabs={tabs}
                activePath={activeTab}
                onActivate={setActiveTab}
                onClose={closeTab}
                flushRef={flushRef}
              />
            </div>
          </Panel>
          <PanelResizeHandle />
          <Panel defaultSize={28} minSize={16}>
            <Chat ws={activeWs} onOpenFile={openFile} />
          </Panel>
        </PanelGroup>
      </div>
      <WorkspaceModal
        open={wsModalOpen}
        activeWs={activeWs}
        onSelect={selectWorkspace}
        onClose={() => setWsModalOpen(false)}
      />
    </div>
  )
}
