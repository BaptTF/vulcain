import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Document, Page } from 'react-pdf'
import '../pdf-worker'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

const MIN_SCALE = 0.4
const MAX_SCALE = 3
const SCALE_STEP = 0.1

export function PdfViewer({ file }: { file: Uint8Array | string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollTopRef = useRef(0)
  const [numPages, setNumPages] = useState(0)
  const [width, setWidth] = useState(0)
  const [scale, setScale] = useState(1)

  const source = useMemo(
    () => (typeof file === 'string' ? file : { data: file }),
    [file]
  )

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const onLoadSuccess = useCallback(({ numPages: next }: { numPages: number }) => {
    setNumPages(next)
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollTopRef.current
    })
  }, [])

  const pageWidth = width > 0 ? Math.max(120, (width - 24) * scale) : undefined

  return (
    <div className="pdf-viewer" ref={hostRef} data-testid="pdf-viewer">
      <div className="pdf-toolbar">
        <button
          type="button"
          className="btn"
          aria-label="Zoom out"
          onClick={() => setScale(s => Math.max(MIN_SCALE, +(s - SCALE_STEP).toFixed(2)))}
        >
          −
        </button>
        <span className="pdf-zoom-label">{Math.round(scale * 100)}%</span>
        <button
          type="button"
          className="btn"
          aria-label="Zoom in"
          onClick={() => setScale(s => Math.min(MAX_SCALE, +(s + SCALE_STEP).toFixed(2)))}
        >
          +
        </button>
        <button type="button" className="btn" onClick={() => setScale(1)}>
          Fit
        </button>
      </div>
      <div
        className="pdf-scroll"
        ref={scrollRef}
        onScroll={e => {
          scrollTopRef.current = e.currentTarget.scrollTop
        }}
      >
        <Document file={source} onLoadSuccess={onLoadSuccess} loading={null}>
          {Array.from({ length: numPages }, (_, i) => (
            <Page
              key={i + 1}
              pageNumber={i + 1}
              width={pageWidth}
              renderAnnotationLayer
              renderTextLayer
            />
          ))}
        </Document>
      </div>
    </div>
  )
}
