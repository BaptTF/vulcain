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
  DockviewDefaultTab,
  DockviewReact,
  themeDark,
  themeLight,
  type DockviewApi,
  type DockviewReadyEvent,
  type GetTabContextMenuItemsParams,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps
} from 'dockview-react'
import FileTree from './FileTree'
import EditorPane, { PreviewPane, type Tab } from './EditorPane'
import Chat from './Chat'

export type PaneId = 'tree' | 'editor' | 'preview' | 'agent'

export const PANE_IDS: PaneId[] = ['tree', 'editor', 'preview', 'agent']

const LAYOUT_KEY = 'vulcain.dock.v2'
const SIZES_KEY = 'vulcain.dock.sizes.v2'

const DEFAULT_PANE_WIDTH: Partial<Record<PaneId, number>> = {
  tree: 240,
  agent: 360
}

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

const TAB_CONTEXT_MENU_ITEMS = ['closeOthers', 'closeAll', 'maximize'] as const

type DockPanel = NonNullable<ReturnType<DockviewApi['getPanel']>>

const hidePaneById: { current: (id: string) => void } = { current: () => {} }

function HideTab(props: IDockviewPanelHeaderProps) {
  return <DockviewDefaultTab {...props} closeActionOverride={() => hidePaneById.current(props.api.id)} />
}

function getTabContextMenuItems(params: GetTabContextMenuItemsParams) {
  return [
    { label: 'Hide', action: () => hidePaneById.current(params.panel.id) },
    ...TAB_CONTEXT_MENU_ITEMS
  ]
}

function isUserHidden(panel: DockPanel | undefined): boolean {
  return panel?.params?.hidden === true
}

function paneIsShown(api: DockviewApi, id: PaneId): boolean {
  const panel = api.getPanel(id)
  return !!panel && panel.api.group.api.isVisible && !isUserHidden(panel)
}

function panesFromApi(api: DockviewApi): Record<PaneId, boolean> {
  return {
    tree: paneIsShown(api, 'tree'),
    editor: paneIsShown(api, 'editor'),
    preview: paneIsShown(api, 'preview'),
    agent: paneIsShown(api, 'agent')
  }
}

function persistLayout(api: DockviewApi): void {
  if (api.width < 8 || api.height < 8) return
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(api.toJSON()))
  } catch {}
}

function readPaneSizes(): Partial<Record<PaneId, number>> {
  try {
    const raw = localStorage.getItem(SIZES_KEY)
    if (!raw) return { ...DEFAULT_PANE_WIDTH }
    const parsed = JSON.parse(raw) as Partial<Record<PaneId, number>>
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_PANE_WIDTH }
    return { ...DEFAULT_PANE_WIDTH, ...parsed }
  } catch {
    return { ...DEFAULT_PANE_WIDTH }
  }
}

function writePaneSizes(sizes: Partial<Record<PaneId, number>>): void {
  try {
    localStorage.setItem(SIZES_KEY, JSON.stringify(sizes))
  } catch {}
}

function snapshotPaneSizes(api: DockviewApi, sizes: Partial<Record<PaneId, number>>): void {
  for (const id of PANE_IDS) {
    const width = api.getPanel(id)?.api.width
    if (typeof width === 'number' && width >= 8) sizes[id] = Math.round(width)
  }
}

function hidePane(panel: DockPanel): void {
  panel.api.updateParameters({ hidden: true })
  const group = panel.api.group
  const shown = group.panels.filter(p => !isUserHidden(p))
  if (shown.length === 0) {
    group.api.setVisible(false)
    return
  }
  const active = group.activePanel
  if (!active || isUserHidden(active)) shown[0]?.api.setActive()
}

function showPane(panel: DockPanel): void {
  panel.api.updateParameters({ hidden: undefined })
  if (!panel.api.group.api.isVisible) panel.api.group.api.setVisible(true)
  panel.api.setActive()
}

function applyUserHiddenState(api: DockviewApi): void {
  for (const panel of api.panels) {
    const hidden = isUserHidden(panel)
    document.querySelectorAll(`.dv-tab[data-tab-panel-id="${panel.id}"]`).forEach(tab => {
      tab.classList.toggle('vulcain-tab-hidden', hidden)
    })
  }
  for (const group of api.groups) {
    const shown = group.panels.filter(p => !isUserHidden(p))
    if (shown.length === 0) {
      if (group.api.isVisible) group.api.setVisible(false)
      continue
    }
    const active = group.activePanel
    if (active && isUserHidden(active)) shown[0]?.api.setActive()
  }
}

function addPane(api: DockviewApi, id: PaneId, sizes: Partial<Record<PaneId, number>>): void {
  if (api.getPanel(id)) return
  const width = sizes[id]
  const panel = api.addPanel({
    id,
    component: id,
    title: PANE_TITLE[id],
    minimumWidth: id === 'tree' ? 140 : 180,
    initialWidth: width,
    position: defaultPosition(api, id)
  })
  if (width) panel.api.setSize({ width })
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
  const persistTimer = useRef(0)
  const restoredRef = useRef(false)
  const sashDragging = useRef(false)
  const paneSizes = useRef(readPaneSizes())
  const [live, setLive] = useState<LiveDoc>({ path: null, text: '' })
  const initialPanes = useRef(panes)

  // Dockview's demo saves on an explicit action. onDidLayoutChange fires
  // throughout a sash drag; writing that snapshot is harmless, but restoring
  // it later would freeze mid-gesture sizes. Skip until pointerup.
  const flushPersist = useCallback(() => {
    window.clearTimeout(persistTimer.current)
    persistTimer.current = 0
    if (sashDragging.current) return
    const api = apiRef.current
    if (!api) return
    snapshotPaneSizes(api, paneSizes.current)
    writePaneSizes(paneSizes.current)
    persistLayout(api)
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
      queueMicrotask(flushPersist)
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
  }, [flushPersist])

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

  hidePaneById.current = (id: string) => {
    const api = apiRef.current
    if (!api) return
    const panel = api.getPanel(id)
    if (!panel || !paneIsShown(api, id as PaneId)) return
    hidePane(panel)
    applyUserHiddenState(api)
    syncPanes(api)
  }

  useImperativeHandle(ref, () => ({
    togglePane(id: PaneId) {
      const api = apiRef.current
      if (!api) return
      const panel = api.getPanel(id)
      if (paneIsShown(api, id) && panel) hidePane(panel)
      else if (panel) showPane(panel)
      else addPane(api, id, paneSizes.current)
      applyUserHiddenState(api)
      syncPanes(api)
    }
  }))

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api
      apiRef.current = api
      restoredRef.current = restoreLayout(api, initialPanes.current)
      applyUserHiddenState(api)
      syncPanes(api)
      if (paneIsShown(api, 'editor')) api.getPanel('editor')?.api.setActive()
      requestAnimationFrame(() => {
        if (!restoredRef.current) applyDefaultSizes(api)
        applyUserHiddenState(api)
        snapshotPaneSizes(api, paneSizes.current)
      })
      api.onDidLayoutChange(() => {
        snapshotPaneSizes(api, paneSizes.current)
        applyUserHiddenState(api)
        schedulePersist()
        syncPanes(api)
      })
      api.onDidAddPanel(() => syncPanes(api))
      api.onDidRemovePanel(() => syncPanes(api))
    },
    [schedulePersist, syncPanes]
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
      <div className="vulcain-dock">
        <DockviewReact
          theme={dockTheme}
          components={dockComponents}
          watermarkComponent={Watermark}
          defaultTabComponent={HideTab}
          getTabContextMenuItems={getTabContextMenuItems}
          onReady={onReady}
        />
      </div>
    </WorkbenchContext.Provider>
  )
})

export default Workbench
