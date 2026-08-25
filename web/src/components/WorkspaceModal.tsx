import { useCallback, useEffect, useRef, useState } from 'react'
import { addWorkspace, browse, getMeta, removeWorkspace, type BrowseResult } from '../api'

interface Props {
  open: boolean
  activeWs: string
  onSelect: (name: string) => void
  onClose: () => void
}

function joinAbs(a: string, b: string): string {
  return a.endsWith('/') ? a + b : a + '/' + b
}

function parentOf(abs: string): string {
  const i = abs.lastIndexOf('/')
  return i <= 0 ? '/' : abs.slice(0, i)
}

function baseName(abs: string): string {
  return abs.split('/').filter(Boolean).pop() ?? abs
}

function crumbsOf(abs: string): { label: string; path: string }[] {
  const segs = abs.split('/').filter(Boolean)
  return [{ label: '/', path: '/' }].concat(
    segs.map((s, i) => ({ label: s, path: '/' + segs.slice(0, i + 1).join('/') }))
  )
}

export default function WorkspaceModal({ open, activeWs, onSelect, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [workspaces, setWorkspaces] = useState<{ name: string; root?: string }[]>([])
  const [result, setResult] = useState<BrowseResult | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const refreshMeta = useCallback(() => {
    getMeta()
      .then(m => setWorkspaces(m.workspaces))
      .catch(e => setError(e.message))
  }, [])

  useEffect(() => {
    const d = dialogRef.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])

  useEffect(() => {
    const d = dialogRef.current
    if (!d) return
    const handler = () => onClose()
    d.addEventListener('close', handler)
    return () => d.removeEventListener('close', handler)
  }, [onClose])

  const goTo = useCallback((path: string) => {
    setError('')
    browse(path)
      .then(r => {
        setResult(r)
        setSelected(null)
        setNewName(baseName(r.abs) || r.abs)
      })
      .catch(e => setError(e.message))
  }, [])

  useEffect(() => {
    if (!open) {
      setResult(null)
      setSelected(null)
      setError('')
      return
    }
    refreshMeta()
    goTo('')
  }, [open, refreshMeta, goTo])

  const target = selected ?? result?.abs ?? ''

  const selectDir = (abs: string) => {
    setSelected(abs)
    setNewName(baseName(abs))
  }

  const addAndSelect = async () => {
    if (!target) return
    const name = newName.trim() || baseName(target)
    setBusy(true)
    setError('')
    try {
      await addWorkspace(name, target)
      refreshMeta()
      onSelect(name)
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
            <div key={w.name} className={`ws-item${w.name === activeWs ? ' active' : ''}`}>
              <button className="ws-open" onClick={() => { onSelect(w.name); onClose() }} title={w.root}>
                <span className="ws-item-name">{w.name === '__config__' ? 'Config' : w.name}</span>
                {w.root && w.name !== '__config__' && <span className="ws-item-path">{w.root}</span>}
              </button>
              {w.name !== '__config__' && (
                <button className="icon-btn" title="Retirer de la config" disabled={busy} onClick={() => void remove(w.name)}>
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="ws-browser">
          <div className="ws-nav">
            <button
              className="icon-btn"
              title="Dossier parent"
              disabled={!result || result.isAtRoot}
              onClick={() => result && goTo(parentOf(result.abs))}
            >
              ↑
            </button>
            <button className="icon-btn" title="Home" onClick={() => goTo('')}>
              ⌂
            </button>
            <div className="ws-crumbs">
              {result &&
                crumbsOf(result.abs).map((c, i) => (
                  <span key={c.path}>
                    {i > 0 && ' / '}
                    <a href="#" onClick={e => { e.preventDefault(); goTo(c.path) }}>
                      {c.label}
                    </a>
                  </span>
                ))}
            </div>
          </div>
          <div className="ws-dirs">
            {(result?.entries ?? []).map(e => {
              const childAbs = joinAbs(result!.abs, e.name)
              return (
                <button
                  key={e.name}
                  className={`ws-dir${selected === childAbs ? ' selected' : ''}`}
                  title={childAbs}
                  onClick={() => selectDir(childAbs)}
                  onDoubleClick={() => goTo(childAbs)}
                >
                  ▤ {e.name}
                </button>
              )
            })}
            {result && result.entries.length === 0 && <div className="ws-empty">Aucun sous-dossier</div>}
            {!result && !error && <div className="ws-empty">Chargement…</div>}
          </div>
        </div>
        {error && <div className="ws-error">{error}</div>}
        <div className="ws-target" title={target}>
          {target || '…'}
        </div>
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
          <button className="btn primary" disabled={busy || !target} onClick={() => void addAndSelect()}>
            Ouvrir ce dossier
          </button>
        </div>
      </div>
    </dialog>
  )
}
