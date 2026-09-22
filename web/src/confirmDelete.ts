import { toast } from 'sonner'

export function confirmDelete(
  name: string,
  onConfirm: () => Promise<void>,
  options?: { description?: string; success?: string }
): void {
  toast(`Supprimer « ${name} » ?`, {
    description: options?.description ?? 'Cette action est définitive.',
    duration: 10000,
    action: {
      label: 'Supprimer',
      onClick: async () => {
        try {
          await onConfirm()
          toast.success(options?.success ?? `« ${name} » supprimé`)
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e)
          toast.error('Suppression impossible', { description: message })
        }
      }
    },
    cancel: { label: 'Annuler', onClick: () => {} }
  })
}
