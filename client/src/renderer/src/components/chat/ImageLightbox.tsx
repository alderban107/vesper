import { useEffect, useState } from 'react'
import { Download, Maximize2, Minimize2, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react'

interface Props {
  src: string
  name: string
  sizeLabel?: string
  onClose: () => void
  onDownload: () => void
}

function clampZoom(nextZoom: number): number {
  return Math.min(4, Math.max(0.5, Number(nextZoom.toFixed(2))))
}

export default function ImageLightbox({
  src,
  name,
  sizeLabel,
  onClose,
  onDownload
}: Props): React.JSX.Element {
  const [zoom, setZoom] = useState(1)
  const [zoomMode, setZoomMode] = useState<'fit' | 'actual'>('fit')

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose()
        return
      }

      if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        setZoom((currentZoom) => clampZoom(currentZoom + 0.25))
        return
      }

      if (event.key === '-') {
        event.preventDefault()
        setZoom((currentZoom) => clampZoom(currentZoom - 0.25))
        return
      }

      if (event.key === '0') {
        event.preventDefault()
        setZoom(1)
        setZoomMode('fit')
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  return (
    <div
      className="vesper-lightbox"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div className="vesper-lightbox-toolbar">
        <div className="vesper-lightbox-meta">
          <span className="vesper-lightbox-title" title={name}>{name}</span>
          {sizeLabel && <span className="vesper-lightbox-size">{sizeLabel}</span>}
          <span className="vesper-lightbox-zoom">{zoomMode === 'fit' ? 'Fit' : `${Math.round(zoom * 100)}%`}</span>
        </div>

        <div className="vesper-lightbox-actions">
          <button
            type="button"
            className="vesper-lightbox-button"
            onClick={() => setZoomMode((currentMode) => (currentMode === 'fit' ? 'actual' : 'fit'))}
            aria-label={zoomMode === 'fit' ? 'Show actual size' : 'Fit image to screen'}
            title={zoomMode === 'fit' ? 'Actual size' : 'Fit to screen'}
          >
            {zoomMode === 'fit' ? <Maximize2 className="w-4 h-4" /> : <Minimize2 className="w-4 h-4" />}
          </button>
          <button
            type="button"
            className="vesper-lightbox-button"
            onClick={() => setZoom((currentZoom) => clampZoom(currentZoom - 0.25))}
            aria-label="Zoom out"
            title="Zoom out"
            disabled={zoomMode === 'fit'}
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            type="button"
            className="vesper-lightbox-button"
            onClick={() => {
              setZoom(1)
              setZoomMode('fit')
            }}
            aria-label="Reset zoom"
            title="Reset zoom"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
          <button
            type="button"
            className="vesper-lightbox-button"
            onClick={() => setZoom((currentZoom) => clampZoom(currentZoom + 0.25))}
            aria-label="Zoom in"
            title="Zoom in"
            disabled={zoomMode === 'fit'}
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            type="button"
            className="vesper-lightbox-button"
            onClick={onDownload}
            aria-label="Download image"
            title="Download image"
          >
            <Download className="w-4 h-4" />
          </button>
          <button
            type="button"
            className="vesper-lightbox-button vesper-lightbox-button-close"
            onClick={onClose}
            aria-label="Close viewer"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div
        className="vesper-lightbox-stage"
        onWheel={(event) => {
          event.preventDefault()
          setZoomMode('actual')
          setZoom((currentZoom) =>
            clampZoom(currentZoom + (event.deltaY < 0 ? 0.1 : -0.1))
          )
        }}
      >
        <img
          src={src}
          alt={name}
          className={zoomMode === 'fit' ? 'vesper-lightbox-image vesper-lightbox-image-fit' : 'vesper-lightbox-image'}
          style={zoomMode === 'fit' ? undefined : { transform: `scale(${zoom})` }}
        />
      </div>
    </div>
  )
}
