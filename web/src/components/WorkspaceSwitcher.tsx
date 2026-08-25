import { useEffect, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { getMeta, removeWorkspace } from '../api'

interface Props {
  activeWs: string
  onSelect: (name: string) => void
  onOpenFolder: () => void
}

export default function WorkspaceSwitcher({ activeWs, onSelect, onOpenFolder }: Props) {
  const [workspaces, setWorkspaces] = useState<{ name: string; root?: string }[]>([])
  const [busy, setBusy] = useState(false)

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

  return (
    <DropdownMenu.Root onOpenChange={open => open && refresh()}>
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
          <DropdownMenu.Item className="ws-menu-item" onSelect={() => onOpenFolder()}>
            <span className="ws-menu-name">Ouvrir un dossier…</span>
          </DropdownMenu.Item>
          {busy && <div className="ws-menu-note">…</div>}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
