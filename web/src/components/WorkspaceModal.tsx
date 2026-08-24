import { useCallback, useEffect, useRef, useState } from 'react'
import { addWorkspace, browse, getMeta, removeWorkspace, type BrowseResult } from '../api'

interface Props {
  open: boolean
  activeWs: string
  onSelect: (name: string) => void
  onClose: () => void
}

export default function WorkspaceModal({ open, activeWs, onSelect, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [result, setResult] = useState<BrowseResult | null>(null)
  const [path, setPath] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const refreshMeta = useCallback(() => {
    getMeta()
      .then(m => setWorkspaces(m.workspaces.map(w => w.name)))
      .catch(e => setError(e.message))
  }, [])

  useEffect(() => {
    const d = dialogRef.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])

  useEffect(() => {
    if (!open) return
    refreshMeta()
    setError('')
    setPath('')
  }, [open, refreshMeta])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    browse(path)
      .then(r => {
        if (!cancelled) {
          setResult(r)
          setError('')
        }
      })
      .catch(e => {
        if (!cancelled) setError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [open, path])

  useEffect(() => {
    const d = dialogRef.current
    if (!d) return
    const handler = () => onClose()
    d.addEventListener('close', handler)
    return () => d.removeEventListener('close', handler)
  }, [onClose])

  const crumbs = [''].concat(result?.path ? result.path.split('/') : [])
  const selectedName = crumbs[crumbs.length - 1] || result?.root.split('/').pop() || 'workspace'
  const [newName, setNewName] = useState('')

  useEffect(() => {
    if (open) setNewName(selectedName)
  }, [open, path])

  const addAndSelect = async () => {
    if (!newName.trim()) return
    setBusy(true)
    setError('')
    try {
      await addWorkspace(newName.trim(), path)
      refreshMeta()
      onSelect(newName.trim())
      onClose()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (name: string) => {
    if (!window.confirm(`Retirer le workspace "${name}" de la config ? (les fichiers ne sont pas supprimés)`)) return
    setBusy(true)
    try {
      await removeWorkspace(name)
      refreshMeta()
      if (name === activeWs) onSelect('__config__')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog ref={dialogRef} className="ws-modal" onClick={e => e.target === dialogRef.current && onClose()}>
      <div className="ws-modal-body">
        <div className="ws-modal-header">
          <span>Workspaces</span>
          <button className="icon-btn" title="Fermer" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="ws-list">
          {workspaces.map(w => (
            <div key={w} className={`ws-item${w === activeWs ? ' active' : ''}`}>
              <button className="ws-open" onClick={() => { onSelect(w); onClose() }} title={w}>
                {w === '__config__' ? 'Config' : w}
              </button>
              {w !== '__config__' && (
                <button className="icon-btn" title="Retirer de la config" disabled={busy} onClick={() => void remove(w)}>
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="ws-browser">
          <div className="ws-crumbs">
            {crumbs.map((c, i) => (
              <span key={i}>
                {i > 0 && ' / '}
                <a href="#" onClick={e => { e.preventDefault(); setPath(crumbs.slice(0, i + 1).filter(Boolean).join('/')) }}>
                  {c || result?.root.split('/').pop() || '…'}
                </a>
              </span>
            ))}
          </div>
          <div className="ws-dirs">
            {(result?.entries ?? []).map(e => (
              <button key={e.name} className="ws-dir" onDoubleClick={() => setPath(result!.path ? `${result!.path}/${e.name}` : e.name)} onClick={() => setPath(result!.path ? `${result!.path}/${e.name}` : e.name)}>
                ▤ {e.name}
              </button>
            ))}
            {result && result.entries.length === 0 && <div className="ws-empty">Aucun sous-dossier</div>}
          </div>
        </div>
        {error && <div className="ws-error">{error}</div>}
        <div className="ws-actions">
          <input
            className="ws-name"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="Nom du workspace"
            onKeyDown={e => {
              if (e.key === 'Enter') void addAndSelect()
            }}
          />
          <button className="btn primary" disabled={busy || !result} onClick={() => void addAndSelect()}>
            Sélectionner ce dossier
          </button>
        </div>
      </div>
    </dialog>
  )
}
