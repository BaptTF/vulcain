import { useEffect, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { createWorkspace, getMeta, removeWorkspace } from '../api'

interface Props {
  activeWs: string
  onSelect: (name: string) => void
  onOpenFolder: () => void
}

export default function WorkspaceSwitcher({ activeWs, onSelect, onOpenFolder }: Props) {
  const [workspaces, setWorkspaces] = useState<{ name: string; root?: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)

  const refresh = () => {
    getMeta()
      .then(m => setWorkspaces(m.workspaces))
      .catch(() => {})
  }

  useEffect(() => {
    refresh()
  }, [])

  const remove = async (name: string) => {
    if (!window.confirm(`Retirer le workspace "${name}" de la config ? (les fichiers ne sont pas supprimés)`)) return
    setBusy(true)
    try {
      await removeWorkspace(name)
      refresh()
      if (name === activeWs) onSelect('__config__')
    } catch {}
    setBusy(false)
  }

  const isConfigWs = activeWs === '__config__'

  const startCreate = () => {
    setCreating(true)
    setNewName('')
    setError('')
  }

  const submitCreate = async () => {
    const name = newName.trim()
    if (!name) return
    if (/[\\/:*?"<>|]/.test(name)) {
      setError('nom de workspace invalide')
      return
    }
    setBusy(true)
    setError('')
    try {
      await createWorkspace(name)
      refresh()
      onSelect(name)
      setMenuOpen(false)
      setCreating(false)
    } catch (e: any) {
      setError(e.message)
    }
    setBusy(false)
  }

  const cancelCreate = () => {
    setCreating(false)
    setNewName('')
    setError('')
  }

  return (
    <DropdownMenu.Root
      open={menuOpen}
      onOpenChange={open => {
        setMenuOpen(open)
        if (open) {
          refresh()
          setCreating(false)
          setError('')
        }
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button className="btn" title="Changer de workspace">
          {isConfigWs ? 'Config' : activeWs || '…'} ▾
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="ws-menu" sideOffset={6} align="start">
          {workspaces.map(w => (
            <DropdownMenu.Item
              key={w.name}
              className={`ws-menu-item${w.name === activeWs ? ' active' : ''}`}
              onSelect={() => onSelect(w.name)}
            >
              <span className="ws-menu-name">{w.name === '__config__' ? 'Config' : w.name}</span>
              {w.root && w.name !== '__config__' && <span className="ws-menu-path">{w.root}</span>}
              {w.name !== '__config__' && (
                <span
                  className="ws-menu-remove"
                  title="Retirer de la config"
                  onPointerDown={e => e.stopPropagation()}
                  onClick={e => {
                    e.stopPropagation()
                    e.preventDefault()
                    void remove(w.name)
                  }}
                >
                  ×
                </span>
              )}
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Separator className="ws-menu-sep" />
          {creating ? (
            <div className="ws-create">
              <input
                className="ws-create-input"
                autoFocus
                value={newName}
                placeholder="Nom du workspace"
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') void submitCreate()
                  if (e.key === 'Escape') cancelCreate()
                }}
              />
              {error && <div className="ws-error">{error}</div>}
              <div className="ws-create-actions">
                <button className="btn" disabled={busy} onClick={cancelCreate}>
                  Annuler
                </button>
                <button className="btn primary" disabled={busy || !newName.trim()} onClick={() => void submitCreate()}>
                  Créer
                </button>
              </div>
            </div>
          ) : (
            <DropdownMenu.Item
              className="ws-menu-item"
              onSelect={e => {
                e.preventDefault()
                startCreate()
              }}
            >
              <span className="ws-menu-name">Nouveau workspace…</span>
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item className="ws-menu-item" onSelect={() => onOpenFolder()}>
            <span className="ws-menu-name">Ouvrir un dossier…</span>
          </DropdownMenu.Item>
          {busy && <div className="ws-menu-note">…</div>}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
