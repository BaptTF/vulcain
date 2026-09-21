import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Document, Page } from 'react-pdf'
import '../pdf-worker'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

// pdf.js's default FontFace injection drops or substitutes many Typst-embedded
// OpenType fonts (the native iframe viewer still looks correct). Draw glyphs
// as paths instead so the preview matches the sibling PDF.
const PDF_OPTIONS = { disableFontFace: true, useSystemFonts: false }

const MIN_SCALE = 0.4
const MAX_SCALE = 3
const SCALE_STEP = 0.1

type Layer = { id: number; data: Uint8Array }

type PdfBuffer = {
  visible: 0 | 1
  slots: [Layer | null, Layer | null]
}

export function NativePdfFrame({ src, title }: { src: string; title: string }) {
  return <iframe className="pdf-frame" data-testid="pdf-frame" src={src} title={title} />
}

export function PdfViewer({ file }: { file: Uint8Array }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollPos = useRef({ top: 0, left: 0 })
  const freezeScroll = useRef(false)
  const nextId = useRef(0)
  const [width, setWidth] = useState(0)
  const [scale, setScale] = useState(1)
  const [buf, setBuf] = useState<PdfBuffer>({ visible: 0, slots: [null, null] })

  const rememberScroll = () => {
    const el = scrollRef.current
    if (!el || freezeScroll.current) return
    scrollPos.current = { top: el.scrollTop, left: el.scrollLeft }
  }

  const restoreScroll = () => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = scrollPos.current.top
    el.scrollLeft = scrollPos.current.left
  }

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const id = ++nextId.current
    const data = file.slice()
    setBuf(prev => {
      const target: 0 | 1 = prev.slots[prev.visible] == null ? prev.visible : ((1 - prev.visible) as 0 | 1)
      const slots: [Layer | null, Layer | null] = [prev.slots[0], prev.slots[1]]
      slots[target] = { id, data }
      return { ...prev, slots }
    })
  }, [file])

  const onLayerReady = useCallback((id: number) => {
    if (id !== nextId.current) return
    rememberScroll()
    freezeScroll.current = true
    setBuf(prev => {
      const idx = prev.slots.findIndex(l => l?.id === id)
      if (idx !== 0 && idx !== 1) return prev
      const other = idx === 0 ? 1 : 0
      if (prev.visible === idx && prev.slots[other] == null) return prev
      const slots: [Layer | null, Layer | null] = [null, null]
      slots[idx] = prev.slots[idx]
      return { visible: idx, slots }
    })
    requestAnimationFrame(() => {
      restoreScroll()
      freezeScroll.current = false
    })
  }, [])

  useLayoutEffect(() => {
    restoreScroll()
    const frame = requestAnimationFrame(() => {
      restoreScroll()
      freezeScroll.current = false
    })
    return () => cancelAnimationFrame(frame)
  }, [buf.visible, buf.slots[0]?.id, buf.slots[1]?.id, scale, width])

  const pageWidth = width > 0 ? Math.max(120, (width - 24) * scale) : undefined

  const bumpScale = (dir: number) => {
    setScale(s => {
      const next = +(s + dir * SCALE_STEP).toFixed(2)
      return Math.min(MAX_SCALE, Math.max(MIN_SCALE, next))
    })
  }

  return (
    <div className="pdf-viewer" ref={hostRef} data-testid="pdf-viewer">
      <div className="pdf-toolbar">
        <button type="button" className="btn" aria-label="Zoom out" onClick={() => bumpScale(-1)}>
          −
        </button>
        <span className="pdf-zoom-label">{Math.round(scale * 100)}%</span>
        <button type="button" className="btn" aria-label="Zoom in" onClick={() => bumpScale(1)}>
          +
        </button>
        <button type="button" className="btn" onClick={() => setScale(1)}>
          Fit
        </button>
      </div>
      <div
        className="pdf-scroll"
        ref={scrollRef}
        onScroll={() => rememberScroll()}
        onWheel={e => {
          if (!e.ctrlKey && !e.metaKey) return
          e.preventDefault()
          bumpScale(e.deltaY > 0 ? -1 : 1)
        }}
      >
        <div className="pdf-stack">
          {pageWidth != null &&
            buf.slots.map((layer, i) =>
              layer ? (
                <PdfLayer
                  key={layer.id}
                  data={layer.data}
                  width={pageWidth}
                  hidden={i !== buf.visible}
                  onReady={() => onLayerReady(layer.id)}
                />
              ) : null
            )}
        </div>
      </div>
    </div>
  )
}

function PdfLayer({
  data,
  width,
  hidden,
  onReady
}: {
  data: Uint8Array
  width: number
  hidden: boolean
  onReady: () => void
}) {
  const [numPages, setNumPages] = useState(0)
  const numPagesRef = useRef(0)
  const rendered = useRef(new Set<number>())
  const readySent = useRef(false)
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const source = useMemo(() => ({ data: new Uint8Array(data) }), [data])

  const markPage = (pageNumber: number) => {
    if (readySent.current) return
    rendered.current.add(pageNumber)
    if (numPagesRef.current > 0 && rendered.current.size >= numPagesRef.current) {
      readySent.current = true
      onReadyRef.current()
    }
  }

  return (
    <div className={`pdf-layer${hidden ? ' is-hidden' : ''}`} aria-hidden={hidden || undefined}>
      <Document
        file={source}
        options={PDF_OPTIONS}
        loading={null}
        onLoadSuccess={({ numPages: n }) => {
          numPagesRef.current = n
          rendered.current = new Set()
          setNumPages(n)
          if (n === 0) {
            readySent.current = true
            onReadyRef.current()
          }
        }}
      >
        {Array.from({ length: numPages }, (_, i) => (
          <Page
            key={i + 1}
            pageNumber={i + 1}
            width={width}
            renderAnnotationLayer
            renderTextLayer
            onRenderSuccess={() => markPage(i + 1)}
            onRenderError={() => markPage(i + 1)}
          />
        ))}
      </Document>
    </div>
  )
}
