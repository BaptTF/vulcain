import { useCallback, useEffect, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { getMeta, setTheme, type Meta } from './api'
import FileTree from './components/FileTree'
import EditorPane, { type Tab } from './components/EditorPane'
import Chat from './components/Chat'

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null)
  const [activeWs, setActiveWs] = useState<string>(() => localStorage.getItem('vulcain.ws') ?? '')
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(null)

  useEffect(() => {
    getMeta().then(m => {
      setMeta(m)
      if (!localStorage.getItem('vulcain.ws')) {
        setActiveWs(m.defaultWorkspace)
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
    setTabs([])
    setActiveTab(null)
  }, [activeWs])

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

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">VULCAIN</span>
        <select value={activeWs} onChange={e => setActiveWs(e.target.value)}>
          {(meta?.workspaces ?? [{ name: activeWs || '...' }]).map(w => (
            <option key={w.name} value={w.name}>
              {isConfigWs && w.name === '__config__' ? 'Config' : w.name}
            </option>
          ))}
          {!isConfigWs && <option value="__config__">Config</option>}
        </select>
        <div className="spacer" />
        {isConfigWs && <span style={{ color: 'var(--muted)' }}>workspace configuration globale</span>}
        <button className="btn" onClick={() => setActiveWs('__config__')} title="Ouvrir la config globale">
          Config
        </button>
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
                onOpen={openFile}
              />
            </div>
          </Panel>
          <PanelResizeHandle />
          <Panel defaultSize={28} minSize={16}>
            <Chat ws={activeWs} onOpenFile={openFile} />
          </Panel>
        </PanelGroup>
      </div>
    </div>
  )
}
