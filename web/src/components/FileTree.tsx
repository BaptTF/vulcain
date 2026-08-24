import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Tree, type NodeApi } from 'react-arborist'
import { getTree, mkdir, remove, rename, touch, type TreeEntry } from '../api'
import { subscribeWatch } from '../watch-client'

interface TreeNode {
  id: string
  name: string
  path: string
  type: 'file' | 'dir'
  children?: TreeNode[]
}

interface Props {
  ws: string
  onOpen: (path: string) => void
}

interface MenuState {
  x: number
  y: number
  path: string
  isDir: boolean
}

interface RowExtras {
  selectedId: string | null
  setSelectedId: (id: string) => void
  onOpen: (path: string) => void
  setMenu: (m: MenuState | null) => void
}

const RowExtrasContext = createContext<RowExtras>({
  selectedId: null,
  setSelectedId: () => {},
  onOpen: () => {},
  setMenu: () => {}
})

function buildTree(entries: TreeEntry[]): TreeNode[] {
  const byPath = new Map<string, TreeNode>()
  const roots: TreeNode[] = []
  for (const e of entries) {
    byPath.set(e.path, { id: e.path, name: e.name, path: e.path, type: e.type })
  }
  for (const e of entries) {
    const node = byPath.get(e.path)!
    const idx = e.path.lastIndexOf('/')
    if (idx === -1) {
      roots.push(node)
    } else {
      const parent = byPath.get(e.path.slice(0, idx))
      if (parent && parent.type === 'dir') {
        ;(parent.children ??= []).push(node)
      } else {
        roots.push(node)
      }
    }
  }
  return roots
}

export default function FileTree({ ws, onOpen }: Props) {
  const [nodes, setNodes] = useState<TreeNode[]>([])
  const [size, setSize] = useState({ w: 200, h: 400 })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const reload = useCallback(() => {
    getTree(ws)
      .then(r => setNodes(buildTree(r.entries)))
      .catch(() => {})
  }, [ws])

  useEffect(() => {
    setSelectedId(null)
    reload()
  }, [ws, reload])

  useEffect(() => {
    let timer = 0
    const unsub = subscribeWatch(ws, () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(reload, 250)
    })
    return () => {
      window.clearTimeout(timer)
      unsub()
    }
  }, [ws, reload])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const r = entries[0].contentRect
      setSize({ w: Math.max(r.width, 100), h: Math.max(r.height, 100) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const parentDirOf = (path: string | null): string => {
    if (!path) return ''
    const node = findNodeById(nodes, path)
    if (!node) return ''
    if (node.type === 'dir') return node.path
    const idx = node.path.lastIndexOf('/')
    return idx === -1 ? '' : node.path.slice(0, idx)
  }

  const doNewFile = async (dir: string) => {
    const name = window.prompt('Nom du fichier :')
    if (!name) return
    const p = dir ? `${dir}/${name}` : name
    await touch(ws, p)
    reload()
    onOpen(p)
  }

  const doNewFolder = async (dir: string) => {
    const name = window.prompt('Nom du dossier :')
    if (!name) return
    await mkdir(ws, dir ? `${dir}/${name}` : name)
    reload()
  }

  const doRename = async (path: string) => {
    const idx = path.lastIndexOf('/')
    const cur = idx === -1 ? path : path.slice(idx + 1)
    const name = window.prompt('Nouveau nom :', cur)
    if (!name || name === cur) return
    const to = idx === -1 ? name : `${path.slice(0, idx)}/${name}`
    await rename(ws, path, to)
    reload()
  }

  const doDelete = async (path: string) => {
    if (!window.confirm(`Supprimer "${path}" ?`)) return
    await remove(ws, path)
    reload()
  }

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menu])

  return (
    <>
      <div className="tree-toolbar">
        <button className="icon-btn" title="Nouveau fichier" onClick={() => doNewFile(parentDirOf(selectedId))}>
          ＋
        </button>
        <button className="icon-btn" title="Nouveau dossier" onClick={() => doNewFolder(parentDirOf(selectedId))}>
          ▤
        </button>
        <div className="spacer" />
        <button className="icon-btn" title="Rafraichir" onClick={reload}>
          ⟳
        </button>
      </div>
      <div className="tree-scroll" ref={wrapRef}>
        {size.h > 50 && (
          <RowExtrasContext.Provider value={{ selectedId, setSelectedId, onOpen, setMenu }}>
            <Tree
              data={nodes}
              width={size.w}
              height={size.h}
              rowHeight={24}
              indent={14}
              openByDefault={false}
              initialOpenState={Object.fromEntries(nodes.filter(n => n.type === 'dir').map(n => [n.id, true]))}
            >
              {RowView}
            </Tree>
          </RowExtrasContext.Provider>
        )}
      </div>
      {menu && (
        <div className="tree-context" style={{ left: menu.x, top: menu.y }}>
          {menu.isDir && (
            <>
              <button onClick={() => doNewFile(menu.path)}>Nouveau fichier ici</button>
              <button onClick={() => doNewFolder(menu.path)}>Nouveau dossier ici</button>
            </>
          )}
          <button onClick={() => doRename(menu.path)}>Renommer</button>
          <button onClick={() => doDelete(menu.path)} style={{ color: 'var(--danger)' }}>
            Supprimer
          </button>
        </div>
      )}
    </>
  )
}

function RowView({ node, style, dragHandle }: any) {
  const { selectedId, setSelectedId, onOpen, setMenu } = useContext(RowExtrasContext)
  const n: NodeApi<TreeNode> = node
  const data = n.data
  const isSelected = selectedId === data.id
  return (
    <div
      ref={dragHandle}
      style={{
        ...style,
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        paddingLeft: 4,
        borderRadius: 5,
        cursor: 'pointer',
        background: isSelected ? 'var(--accent-soft)' : undefined,
        color: isSelected ? 'var(--text)' : undefined
      }}
      title={data.path}
      onClick={() => {
        setSelectedId(data.id)
        if (n.isInternal) n.toggle()
        else onOpen(data.path)
      }}
      onContextMenu={e => {
        e.preventDefault()
        setSelectedId(data.id)
        setMenu({ x: e.clientX, y: e.clientY, path: data.path, isDir: n.isInternal })
      }}
    >
      <span style={{ color: 'var(--muted)', fontSize: 10, width: 10, textAlign: 'center' }}>
        {n.isInternal ? (n.isOpen ? '▾' : '▸') : ''}
      </span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.name}</span>
    </div>
  )
}

function findNodeById(nodes: TreeNode[], id: string): TreeNode | null {
  for (const n of nodes) {
    if (n.id === id) return n
    if (n.children) {
      const hit = findNodeById(n.children, id)
      if (hit) return hit
    }
  }
  return null
}
