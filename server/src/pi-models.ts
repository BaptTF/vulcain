export type PiProviderConfig = {
  name?: string
  baseUrl?: string
  api?: string
  apiKey?: string
  models?: unknown[]
  compat?: unknown
}

export function buildPiModelsDoc(provider: PiProviderConfig): {
  providers: Record<string, Record<string, unknown>>
} {
  const name = provider.name ?? 'custom'
  return {
    providers: {
      [name]: {
        baseUrl: provider.baseUrl,
        api: provider.api,
        ...(provider.apiKey !== undefined ? { apiKey: provider.apiKey } : {}),
        ...(provider.compat !== undefined ? { compat: provider.compat } : {}),
        models: provider.models ?? []
      }
    }
  }
}
