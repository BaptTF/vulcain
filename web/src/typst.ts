import { $typst, loadFonts } from '@myriaddreamin/typst.ts/dist/esm/index.mjs'

let initPromise: Promise<void> | null = null

const USER_FONTS = [
  '/fonts/AtkinsonHyperlegible-Regular.otf',
  '/fonts/AtkinsonHyperlegible-Italic.otf',
  '/fonts/AtkinsonHyperlegible-Bold.otf',
  '/fonts/AtkinsonHyperlegible-BoldItalic.otf'
]

const MAIN = '/preview.typ'

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
  const compiler = await $typst.getCompiler()
  compiler.addSource(MAIN, source)
  // runWithWorld frees the compile snapshot. $typst.pdf({ mainContent }) instead
  // allocates a new /tmp/*.typ, calls compiler.reset() (drops font caches into
  // the WASM heap), and never world.free()s — that grows the tab without bound.
  const out = (await compiler.runWithWorld({ mainFilePath: MAIN }, world =>
    world.pdf({ diagnostics: 'none' })
  )) as { result?: Uint8Array }
  const data = out.result
  if (!data) throw new Error('Typst compile produced no PDF')
  return new Uint8Array(data)
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}
