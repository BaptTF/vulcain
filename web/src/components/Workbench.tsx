import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MutableRefObject
} from 'react'
import {
  DockviewReact,
  themeDark,
  themeLight,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps
} from 'dockview-react'
import FileTree from './FileTree'
import EditorPane, { PreviewPane, type Tab } from './EditorPane'
import Chat from './Chat'

export type PaneId = 'tree' | 'editor' | 'preview' | 'agent'

export const PANE_IDS: PaneId[] = ['tree', 'editor', 'preview', 'agent']

const LAYOUT_KEY = 'vulcain.dock.v2'

const PANE_TITLE: Record<PaneId, string> = {
  tree: 'Tree',
  editor: 'Editor',
  preview: 'Preview',
  agent: 'Agent'
}

export interface WorkbenchHandle {
  togglePane: (id: PaneId) => void
}

interface LiveDoc {
  path: string | null
  text: string
}

interface WorkbenchValue {
  ws: string
  tabs: Tab[]
  activePath: string | null
  onActivate: (path: string) => void
  onClose: (path: string) => void
  onOpen: (path: string) => void
  flushRef: MutableRefObject<(() => void) | null>
  live: LiveDoc
  setLive: (doc: LiveDoc) => void
}

const WorkbenchContext = createContext<WorkbenchValue | null>(null)

function useWorkbench(): WorkbenchValue {
  const ctx = useContext(WorkbenchContext)
  if (!ctx) throw new Error('WorkbenchContext missing')
  return ctx
}

function TreeDock(_props: IDockviewPanelProps) {
  const { ws, onOpen } = useWorkbench()
  return (
    <div className="panel-tree" data-testid="tree">
      <FileTree ws={ws} onOpen={onOpen} />
    </div>
  )
}

function EditorDock(_props: IDockviewPanelProps) {
  const { ws, tabs, activePath, onActivate, onClose, flushRef, setLive } = useWorkbench()
  return (
    <div className="panel-center" data-testid="editor">
      <EditorPane
        ws={ws}
        tabs={tabs}
        activePath={activePath}
        onActivate={onActivate}
        onClose={onClose}
        flushRef={flushRef}
        onLiveChange={(path, text) => setLive({ path, text })}
      />
    </div>
  )
}

function PreviewDock(_props: IDockviewPanelProps) {
  const { ws, live } = useWorkbench()
  return <PreviewPane ws={ws} path={live.path} content={live.text} />
}

function AgentDock(_props: IDockviewPanelProps) {
  const { ws, onOpen } = useWorkbench()
  return (
    <div className="panel-chat-host" data-testid="agent">
      <Chat key={ws} ws={ws} onOpenFile={onOpen} />
    </div>
  )
}

const dockComponents = {
  tree: TreeDock,
  editor: EditorDock,
  preview: PreviewDock,
  agent: AgentDock
}

function Watermark() {
  return <div className="empty-state">Réouvrez un panneau depuis la barre du haut</div>
}

function panesFromApi(api: DockviewApi): Record<PaneId, boolean> {
  const open = new Set(api.panels.map(p => p.id))
  return {
    tree: open.has('tree'),
    editor: open.has('editor'),
    preview: open.has('preview'),
    agent: open.has('agent')
  }
}

function persistLayout(api: DockviewApi): void {
  if (api.width < 8 || api.height < 8) return
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(api.toJSON()))
  } catch {}
}

function addPane(api: DockviewApi, id: PaneId): void {
  if (api.getPanel(id)) return
  api.addPanel({
    id,
    component: id,
    title: PANE_TITLE[id],
    minimumWidth: id === 'tree' ? 140 : 180,
    position: defaultPosition(api, id)
  })
}

function defaultPosition(api: DockviewApi, id: PaneId) {
  if (id === 'tree') return { direction: 'left' as const }
  if (id === 'agent') return { direction: 'right' as const }
  if (id === 'preview') {
    if (api.getPanel('editor')) return { referencePanel: 'editor', direction: 'right' as const }
    if (api.getPanel('agent')) return { referencePanel: 'agent', direction: 'left' as const }
    if (api.getPanel('tree')) return { referencePanel: 'tree', direction: 'right' as const }
    return { direction: 'right' as const }
  }
  if (id === 'editor') {
    if (api.getPanel('preview')) return { referencePanel: 'preview', direction: 'left' as const }
    if (api.getPanel('agent')) return { referencePanel: 'agent', direction: 'left' as const }
    if (api.getPanel('tree')) return { referencePanel: 'tree', direction: 'right' as const }
    return { direction: 'right' as const }
  }
  return { direction: 'right' as const }
}

function applyDefaultLayout(api: DockviewApi, visible: Record<PaneId, boolean>): void {
  if (visible.tree) {
    api.addPanel({ id: 'tree', component: 'tree', title: PANE_TITLE.tree, initialWidth: 240 })
  }
  if (visible.editor) {
    api.addPanel({
      id: 'editor',
      component: 'editor',
      title: PANE_TITLE.editor,
      minimumWidth: 180,
      position: visible.tree ? { referencePanel: 'tree', direction: 'right' } : undefined
    })
  }
  if (visible.preview) {
    const ref = visible.editor ? 'editor' : visible.tree ? 'tree' : undefined
    api.addPanel({
      id: 'preview',
      component: 'preview',
      title: PANE_TITLE.preview,
      minimumWidth: 180,
      position: ref ? { referencePanel: ref, direction: 'right' } : undefined
    })
  }
  if (visible.agent) {
    const ref = visible.preview ? 'preview' : visible.editor ? 'editor' : visible.tree ? 'tree' : undefined
    api.addPanel({
      id: 'agent',
      component: 'agent',
      title: PANE_TITLE.agent,
      initialWidth: 360,
      minimumWidth: 180,
      position: ref ? { referencePanel: ref, direction: 'right' } : undefined
    })
  }
  api.getPanel('editor')?.api.setActive()
}

function applyDefaultSizes(api: DockviewApi): void {
  api.getPanel('tree')?.api.setSize({ width: 240 })
  api.getPanel('agent')?.api.setSize({ width: 360 })
}

function restoreLayout(api: DockviewApi, fallback: Record<PaneId, boolean>): boolean {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed.grid &&
        parsed.panels &&
        parsed.grid.width >= 8 &&
        parsed.grid.height >= 8
      ) {
        api.fromJSON(parsed)
        return true
      }
    }
  } catch {}
  applyDefaultLayout(api, fallback)
  return false
}

interface Props {
  ws: string
  theme: 'dark' | 'light'
  panes: Record<PaneId, boolean>
  onPanesChange: (panes: Record<PaneId, boolean>) => void
  tabs: Tab[]
  activePath: string | null
  onActivate: (path: string) => void
  onClose: (path: string) => void
  onOpen: (path: string) => void
  flushRef: MutableRefObject<(() => void) | null>
}

const Workbench = forwardRef<WorkbenchHandle, Props>(function Workbench(
  { ws, theme, panes, onPanesChange, tabs, activePath, onActivate, onClose, onOpen, flushRef },
  ref
) {
  const apiRef = useRef<DockviewApi | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const persistTimer = useRef(0)
  const restoredRef = useRef(false)
  const sashDragging = useRef(false)
  const [live, setLive] = useState<LiveDoc>({ path: null, text: '' })
  const initialPanes = useRef(panes)

  // Auto-resize calls api.layout() from a rAF'd ResizeObserver. layout()
  // reapplies the last saveProportions() snapshot, which is only updated on
  // sash pointerup — so any layout() during a drag snaps the sash back.
  const fitHost = useCallback(() => {
    const api = apiRef.current
    const el = hostRef.current
    if (!api || !el || sashDragging.current) return
    const { width, height } = el.getBoundingClientRect()
    if (width < 8 || height < 8) return
    if (Math.abs(api.width - width) < 2 && Math.abs(api.height - height) < 2) return
    api.layout(width, height)
  }, [])

  const flushPersist = useCallback(() => {
    window.clearTimeout(persistTimer.current)
    persistTimer.current = 0
    if (sashDragging.current) return
    if (apiRef.current) persistLayout(apiRef.current)
  }, [])

  const schedulePersist = useCallback(() => {
    if (sashDragging.current) return
    window.clearTimeout(persistTimer.current)
    persistTimer.current = window.setTimeout(flushPersist, 200)
  }, [flushPersist])

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null
      if (!t?.closest('.dv-sash')) return
      sashDragging.current = true
      window.clearTimeout(persistTimer.current)
    }
    const up = () => {
      if (!sashDragging.current) return
      sashDragging.current = false
      // Dockview saveProportions() runs on the bubble pointerup. Wait so we
      // persist the new sizes and never layout() with the pre-drag snapshot.
      queueMicrotask(() => {
        flushPersist()
        fitHost()
      })
    }
    const onHide = () => {
      if (document.visibilityState === 'hidden') flushPersist()
    }
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('pointerup', up, true)
    document.addEventListener('pointercancel', up, true)
    window.addEventListener('pagehide', flushPersist)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('pointerup', up, true)
      document.removeEventListener('pointercancel', up, true)
      window.removeEventListener('pagehide', flushPersist)
      document.removeEventListener('visibilitychange', onHide)
      window.clearTimeout(persistTimer.current)
    }
  }, [fitHost, flushPersist])

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const ro = new ResizeObserver(() => fitHost())
    ro.observe(el)
    return () => ro.disconnect()
  }, [fitHost])

  const value = useMemo<WorkbenchValue>(
    () => ({
      ws,
      tabs,
      activePath,
      onActivate,
      onClose,
      onOpen,
      flushRef,
      live,
      setLive
    }),
    [ws, tabs, activePath, onActivate, onClose, onOpen, flushRef, live]
  )

  const syncPanes = useCallback(
    (api: DockviewApi) => {
      onPanesChange(panesFromApi(api))
    },
    [onPanesChange]
  )

  useImperativeHandle(ref, () => ({
    togglePane(id: PaneId) {
      const api = apiRef.current
      if (!api) return
      const panel = api.getPanel(id)
      if (panel) panel.api.close()
      else addPane(api, id)
    }
  }))

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api
      apiRef.current = api
      const grid = api as unknown as {
        component: { layout: (width: number, height: number, force?: boolean) => void }
      }
      const layoutGrid = grid.component.layout.bind(grid.component)
      grid.component.layout = (width, height, force) => {
        if (sashDragging.current) return
        layoutGrid(width, height, force)
      }
      restoredRef.current = restoreLayout(api, initialPanes.current)
      syncPanes(api)
      api.getPanel('editor')?.api.setActive()
      requestAnimationFrame(() => {
        fitHost()
        if (!restoredRef.current) applyDefaultSizes(api)
      })
      api.onDidLayoutChange(() => schedulePersist())
      api.onDidAddPanel(() => syncPanes(api))
      api.onDidRemovePanel(() => syncPanes(api))
    },
    [fitHost, schedulePersist, syncPanes]
  )

  const dockTheme = useMemo(() => {
    const base = theme === 'light' ? themeLight : themeDark
    return {
      ...base,
      name: 'vulcain',
      className: `${base.className} dockview-theme-vulcain`
    }
  }, [theme])

  return (
    <WorkbenchContext.Provider value={value}>
      <div className="vulcain-dock" ref={hostRef}>
        <DockviewReact
          theme={dockTheme}
          components={dockComponents}
          watermarkComponent={Watermark}
          disableAutoResizing
          // Panes are singletons toggled from the view bar; disable group DND
          // so the tab-bar void next to a sash cannot steal a resize drag.
          disableDnd
          getTabContextMenuItems={() => ['close', 'closeOthers', 'closeAll', 'maximize']}
          onReady={onReady}
        />
      </div>
    </WorkbenchContext.Provider>
  )
})

export default Workbench
