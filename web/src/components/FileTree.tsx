import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useDropzone } from 'react-dropzone'
import { Tree, type MoveHandler, type NodeApi, type RenameHandler, type TreeApi } from 'react-arborist'
import { toast } from 'sonner'
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
  background?: boolean
}

interface PendingCreate {
  id: string
  dir: string
  type: 'file' | 'dir'
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
    const node: TreeNode = { id: e.path, name: e.name, path: e.path, type: e.type }
    if (e.type === 'dir') node.children = []
    byPath.set(e.path, node)
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

function insertTemp(list: TreeNode[], dir: string, tmp: TreeNode): TreeNode[] | null {
  for (let i = 0; i < list.length; i++) {
    const n = list[i]
    if (n.type === 'dir' && n.path === dir) {
      const copy: TreeNode = { ...n, children: [...(n.children ?? []), tmp] }
      return [...list.slice(0, i), copy, ...list.slice(i + 1)]
    }
    if (n.children) {
      const sub = insertTemp(n.children, dir, tmp)
      if (sub) return [...list.slice(0, i), { ...n, children: sub }, ...list.slice(i + 1)]
    }
  }
  return null
}

function removeById(list: TreeNode[], id: string): TreeNode[] | null {
  for (let i = 0; i < list.length; i++) {
    const n = list[i]
    if (n.id === id) return [...list.slice(0, i), ...list.slice(i + 1)]
    if (n.children) {
      const sub = removeById(n.children, id)
      if (sub) return [...list.slice(0, i), { ...n, children: sub }, ...list.slice(i + 1)]
    }
  }
  return null
}

export default function FileTree({ ws, onOpen }: Props) {
  const [nodes, setNodes] = useState<TreeNode[]>([])
  const [size, setSize] = useState({ w: 200, h: 400 })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<TreeApi<TreeNode> | undefined>(undefined)

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
        toast.error('Upload impossible', { description: String(e?.message ?? e) })
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

  const requestDelete = useCallback(
    (path: string) => {
      toast(`Supprimer « ${path} » ?`, {
        description: 'Cette action est définitive.',
        duration: 10000,
        action: {
          label: 'Supprimer',
          onClick: async () => {
            try {
              await remove(ws, path)
              toast.success(`« ${path} » supprimé`)
            } catch (e: any) {
              toast.error('Suppression impossible', { description: String(e?.message ?? e) })
            }
            reload()
          }
        },
        cancel: { label: 'Annuler', onClick: () => {} }
      })
    },
    [ws, reload]
  )

  const tmpSeq = useRef(0)
  const pendingCreate = useRef<PendingCreate | null>(null)

  const discardTemp = useCallback((id: string) => {
    setNodes(prev => removeById(prev, id) ?? prev)
  }, [])

  const handleRename: RenameHandler<TreeNode> = useCallback(
    async ({ id, name }) => {
      const pending = pendingCreate.current
      if (pending && pending.id === id) {
        pendingCreate.current = null
        discardTemp(id)
        const clean = name.trim()
        if (!clean || clean.includes('/')) return
        const p = pending.dir ? `${pending.dir}/${clean}` : clean
        try {
          if (pending.type === 'dir') {
            await mkdir(ws, p)
          } else {
            await touch(ws, p)
            onOpen(p)
          }
        } catch (e: any) {
          toast.error('Création impossible', { description: String(e?.message ?? e) })
        }
        reload()
        return
      }
      const clean = name.trim()
      if (!clean || clean.includes('/') || clean === id) return
      const idx = id.lastIndexOf('/')
      const to = idx === -1 ? clean : `${id.slice(0, idx)}/${clean}`
      try {
        await rename(ws, id, to)
      } catch (e: any) {
        toast.error('Renommage impossible', { description: String(e?.message ?? e) })
      }
      reload()
    },
    [ws, reload, onOpen, discardTemp]
  )

  const beginCreate = useCallback(
    (type: 'file' | 'dir', dir: string) => {
      const tree = treeRef.current
      if (!tree) return
      if (dir) tree.open(dir)
      const id = `__new_${type}_${Date.now()}_${++tmpSeq.current}`
      pendingCreate.current = { id, dir, type }
      const tmp: TreeNode = { id, name: '', path: dir ? `${dir}/` : '', type: type === 'dir' ? 'dir' : 'file' }
      setNodes(prev => (dir ? insertTemp(prev, dir, tmp) ?? [...prev, tmp] : [...prev, tmp]))
      window.setTimeout(async () => {
        try {
          const res = await tree.edit(id)
          if (res.cancelled) {
            pendingCreate.current = null
            discardTemp(id)
          }
        } catch {}
      }, 0)
    },
    [discardTemp]
  )

  const handleMove: MoveHandler<TreeNode> = useCallback(
    async ({ dragIds, parentId }) => {
      try {
        for (const id of dragIds) {
          if (id.startsWith('__new_')) continue
          const base = id.slice(id.lastIndexOf('/') + 1)
          const to = parentId ? `${parentId}/${base}` : base
          if (to === id) continue
          await rename(ws, id, to)
        }
      } catch (e: any) {
        toast.error('Déplacement impossible', { description: String(e?.message ?? e) })
      }
      reload()
    },
    [ws, reload]
  )

  const beginRename = useCallback((path: string) => {
    const tree = treeRef.current
    if (!tree) return
    void tree.edit(path)
  }, [])

  const runMenu = useCallback((fn: () => void) => {
    setMenu(null)
    fn()
  }, [])

  const onTreeKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'F2') return
    const tree = treeRef.current
    if (!tree) return
    const node = (selectedId ? tree.get(selectedId) : null) ?? tree.focusedNode
    if (!node || node.isEditing) return
    e.preventDefault()
    void tree.edit(node)
  }

  const onBackgroundContextMenu = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-row]')) return
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, path: '', isDir: false, background: true })
  }

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', esc)
    }
  }, [menu])

  return (
    <>
      <div className="tree-toolbar">
        <button
          className="icon-btn"
          title="Nouveau fichier"
          onClick={() => beginCreate('file', parentDirOf(selectedId))}
        >
          ＋
        </button>
        <button
          className="icon-btn"
          title="Nouveau dossier"
          onClick={() => beginCreate('dir', parentDirOf(selectedId))}
        >
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
        {...getRootProps({
          className: 'tree-scroll' + (isDragActive ? ' drag-over' : '')
        })}
        ref={wrapRef}
        onKeyDown={onTreeKeyDown}
        onContextMenu={onBackgroundContextMenu}
      >
        {size.h > 50 && (
          <RowExtrasContext.Provider value={{ selectedId, setSelectedId, onOpen, setMenu }}>
            <Tree
              ref={treeRef}
              data={nodes}
              width={size.w}
              height={size.h}
              rowHeight={24}
              indent={14}
              openByDefault={false}
              initialOpenState={Object.fromEntries(nodes.filter(n => n.type === 'dir').map(n => [n.id, true]))}
              onRename={handleRename}
              onMove={handleMove}
            >
              {RowView}
            </Tree>
          </RowExtrasContext.Provider>
        )}
        {uploading && <div className="tree-uploading">Upload en cours…</div>}
      </div>
      {menu && (
        <div className="tree-context" style={{ left: menu.x, top: menu.y }} onClick={e => e.stopPropagation()}>
          {menu.background ? (
            <>
              <button onClick={() => runMenu(() => beginCreate('file', ''))}>Nouveau fichier</button>
              <button onClick={() => runMenu(() => beginCreate('dir', ''))}>Nouveau dossier</button>
              <button onClick={() => runMenu(() => pickInto(''))}>Uploader ici</button>
            </>
          ) : menu.isDir ? (
            <>
              <button onClick={() => runMenu(() => beginCreate('file', menu!.path))}>Nouveau fichier ici</button>
              <button onClick={() => runMenu(() => beginCreate('dir', menu!.path))}>Nouveau dossier ici</button>
              <button onClick={() => runMenu(() => pickInto(menu!.path))}>Uploader ici</button>
              <div className="sep" />
              <button onClick={() => runMenu(() => beginRename(menu!.path))}>Renommer</button>
              <button className="danger" onClick={() => runMenu(() => requestDelete(menu!.path))}>
                Supprimer
              </button>
            </>
          ) : (
            <>
              <a href={downloadUrl(ws, menu.path)} download onClick={() => setMenu(null)}>
                Télécharger
              </a>
              <button onClick={() => runMenu(() => beginRename(menu!.path))}>Renommer</button>
              <button className="danger" onClick={() => runMenu(() => requestDelete(menu!.path))}>
                Supprimer
              </button>
            </>
          )}
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

const iconSvgProps = {
  width: 14,
  height: 14,
  viewBox: '0 0 16 16',
  'aria-hidden': true,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.1,
  style: { flexShrink: 0 }
} as const

function FolderIcon({ open }: { open?: boolean }) {
  return (
    <svg {...iconSvgProps}>
      {open ? (
        <>
          <path d="M2.5 10.5V3.5h3.6l1.3 1.3h6.9c.386 0 .7.314.7.7v2" />
          <path d="M2 13.75l2-5.1a.7.7 0 0 1 .65-.45h10.3a.35.35 0 0 1 .33.47l-2 5.1a.7.7 0 0 1-.66.43H2a.4.4 0 0 1-.37-.52z" />
        </>
      ) : (
        <path d="M1.5 12.8V3.2c0-.386.314-.7.7-.7h3.9l1.3 1.3h6.9c.386 0 .7.314.7.7v8.3c0 .386-.314.7-.7.7H2.2a.7.7 0 0 1-.7-.7z" />
      )}
    </svg>
  )
}

function FileIcon() {
  return (
    <svg {...iconSvgProps} strokeLinejoin="round">
      <path d="M13.5 14.5h-11V1.5h7l4 4v9z" />
      <path d="M9.5 1.5v4h4" />
    </svg>
  )
}

function RowView({ node, style, dragHandle }: any) {
  const { selectedId, setSelectedId, onOpen, setMenu } = useContext(RowExtrasContext)
  const n: NodeApi<TreeNode> = node
  const data = n.data
  const isDir = data.type === 'dir'
  const isSelected = selectedId === data.id
  const editing = n.isEditing
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  return (
    <div
      ref={dragHandle}
      data-row="1"
      style={{
        ...style,
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        borderRadius: 5,
        cursor: editing ? 'default' : 'pointer',
        background: isSelected ? 'var(--accent-soft)' : undefined,
        color: isSelected ? 'var(--text)' : undefined
      }}
      title={editing ? undefined : data.path}
      onClick={() => {
        if (editing) return
        setSelectedId(data.id)
        if (isDir) n.toggle()
        else onOpen(data.path)
      }}
      onContextMenu={e => {
        e.preventDefault()
        e.stopPropagation()
        if (editing) return
        setSelectedId(data.id)
        setMenu({ x: e.clientX, y: e.clientY, path: data.path, isDir })
      }}
    >
      <span style={{ color: 'var(--muted)', fontSize: 10, width: 10, textAlign: 'center', flexShrink: 0 }}>
        {isDir ? (n.isOpen ? '▾' : '▸') : ''}
      </span>
      {isDir ? <FolderIcon open={n.isOpen} /> : <FileIcon />}
      {editing ? (
        <input
          ref={inputRef}
          className="tree-edit-input"
          defaultValue={data.name}
          spellCheck={false}
          draggable={false}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              n.submit(e.currentTarget.value)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              n.reset()
            }
          }}
          onBlur={() => n.reset()}
        />
      ) : (
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.name}</span>
      )}
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
