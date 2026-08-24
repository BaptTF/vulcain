import { $typst } from '@myriaddreamin/typst.ts/dist/esm/index.mjs'

let initPromise: Promise<void> | null = null

async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      $typst.setCompilerInitOptions({
        getModule: () => '/assets/typst_ts_web_compiler_bg.wasm'
      })
      $typst.setRendererInitOptions({
        getModule: () => '/assets/typst_ts_renderer_bg.wasm'
      })
    })()
    initPromise.catch(() => {
      initPromise = null
    })
  }
  return initPromise
}

export async function typstSvg(source: string): Promise<string> {
  await ensureInit()
  return (await $typst.svg({ mainContent: source })) as unknown as string
}

export async function typstPdfBytes(source: string): Promise<Uint8Array> {
  await ensureInit()
  const data = await $typst.pdf({ mainContent: source })
  return data as Uint8Array
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}
