import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useDropzone } from 'react-dropzone'
import { Tree, type NodeApi } from 'react-arborist'
import { downloadUrl, getTree, mkdir, remove, rename, touch, writeFileBase64, type TreeEntry } from '../api'
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

  const uploadDirRef = useRef('')
  const [uploading, setUploading] = useState(false)

  const uploadFiles = useCallback(
    async (files: File[], dir: string) => {
      if (files.length === 0) return
      setUploading(true)
      try {
        for (const f of files) {
          const base64 = await fileToBase64(f)
          const rel = dir ? `${dir}/${f.name}` : f.name
          await writeFileBase64(ws, rel, base64)
        }
      } catch (e: any) {
        alert(`Upload impossible : ${e?.message ?? e}`)
      } finally {
        setUploading(false)
        reload()
      }
    },
    [ws, reload]
  )

  const onDrop = useCallback((files: File[]) => void uploadFiles(files, ''), [uploadFiles])
  const { getRootProps, getInputProps, isDragActive, open: pickFiles } = useDropzone({
    onDrop,
    noClick: true,
    noKeyboard: true
  })

  const pickInto = (dir: string) => {
    uploadDirRef.current = dir
    pickFiles()
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
        <input {...getInputProps()} />
        <button className="icon-btn" title="Uploader des fichiers" disabled={uploading} onClick={() => pickInto('')}>
          ⇧
        </button>
        <div className="spacer" />
        <button className="icon-btn" title="Rafraichir" onClick={reload}>
          ⟳
        </button>
      </div>
      <div
        {...getRootProps({ className: 'tree-scroll' + (isDragActive ? ' drag-over' : '') })}
        ref={wrapRef}
      >
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
        {uploading && <div className="tree-uploading">Upload en cours…</div>}
      </div>
      {menu && (
        <div className="tree-context" style={{ left: menu.x, top: menu.y }}>
          {menu.isDir ? (
            <>
              <button onClick={() => doNewFile(menu.path)}>Nouveau fichier ici</button>
              <button onClick={() => doNewFolder(menu.path)}>Nouveau dossier ici</button>
              <button onClick={() => pickInto(menu.path)}>Uploader ici</button>
            </>
          ) : (
            <>
              <a href={downloadUrl(ws, menu.path)} download>
                Télécharger
              </a>
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

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1))
    r.onerror = () => reject(r.error ?? new Error('lecture impossible'))
    r.readAsDataURL(file)
  })
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
