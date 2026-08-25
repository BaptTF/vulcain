import { useCallback, useEffect, useRef, useState } from 'react'
import * as ContextMenu from '@radix-ui/react-context-menu'
import { addWorkspace, browse, browseMkdir, type BrowseResult } from '../api'

interface Props {
  open: boolean
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

export default function WorkspaceModal({ open, onSelect, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [result, setResult] = useState<BrowseResult | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

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
    goTo('')
  }, [open, goTo])

  const target = selected ?? result?.abs ?? ''

  const selectDir = (abs: string) => {
    setSelected(abs)
    setNewName(baseName(abs))
  }

  const makeDir = async (parent: string) => {
    const dir = parent ? joinAbs(parent, 'Nouveau dossier') : 'Nouveau dossier'
    setBusy(true)
    setError('')
    try {
      await browseMkdir(dir)
      const r = await browse(result?.abs ?? '')
      setResult(r)
      setSelected(dir)
      setNewName(baseName(dir))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const addAndSelect = async () => {
    if (!target) return
    const name = newName.trim() || baseName(target)
    setBusy(true)
    setError('')
    try {
      await addWorkspace(name, target)
      onSelect(name)
      onClose()
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
          <span>Ouvrir un dossier</span>
          <button className="icon-btn" title="Fermer" onClick={onClose}>
            ×
          </button>
        </div>
        <ContextMenu.Root>
          <ContextMenu.Trigger asChild>
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
                    <ContextMenu.Root key={e.name}>
                      <ContextMenu.Trigger asChild>
                        <button
                          className={`ws-dir${selected === childAbs ? ' selected' : ''}`}
                          title={childAbs}
                          onClick={() => selectDir(childAbs)}
                          onDoubleClick={() => goTo(childAbs)}
                        >
                          ▤ {e.name}
                        </button>
                      </ContextMenu.Trigger>
                      <ContextMenu.Content className="ws-menu">
                        <ContextMenu.Item
                          className="ws-menu-item"
                          onSelect={() => void makeDir(childAbs)}
                        >
                          <span className="ws-menu-name">Nouveau dossier ici</span>
                        </ContextMenu.Item>
                      </ContextMenu.Content>
                    </ContextMenu.Root>
                  )
                })}
                {result && result.entries.length === 0 && <div className="ws-empty">Aucun sous-dossier</div>}
                {!result && !error && <div className="ws-empty">Chargement…</div>}
              </div>
            </div>
          </ContextMenu.Trigger>
          <ContextMenu.Content className="ws-menu">
            <ContextMenu.Item className="ws-menu-item" onSelect={() => void makeDir(result?.abs ?? '')}>
              <span className="ws-menu-name">Nouveau dossier</span>
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Root>
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
