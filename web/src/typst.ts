import { $typst, loadFonts } from '@myriaddreamin/typst.ts/dist/esm/index.mjs'

let initPromise: Promise<void> | null = null

const USER_FONTS = [
  '/fonts/AtkinsonHyperlegible-Regular.otf',
  '/fonts/AtkinsonHyperlegible-Italic.otf',
  '/fonts/AtkinsonHyperlegible-Bold.otf',
  '/fonts/AtkinsonHyperlegible-BoldItalic.otf'
]

export function siblingPdfPath(typPath: string): string {
  return typPath.replace(/\.typ$/i, '') + '.pdf'
}

export async function ensureTypstCompiler(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      $typst.setCompilerInitOptions({
        getModule: () => '/assets/typst_ts_web_compiler_bg.wasm',
        beforeBuild: [loadFonts(USER_FONTS)]
      })
    })()
    initPromise.catch(() => {
      initPromise = null
    })
  }
  return initPromise
}

export async function typstPdfBytes(source: string): Promise<Uint8Array> {
  await ensureTypstCompiler()
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
