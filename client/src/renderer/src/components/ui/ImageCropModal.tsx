import { useCallback, useState } from 'react'
import Cropper from 'react-easy-crop'
import type { Area } from 'react-easy-crop'
import { X, Loader2, ZoomIn, ZoomOut } from 'lucide-react'

interface ImageCropModalProps {
  file: File
  title: string
  cropShape: 'round' | 'rect'
  aspect: number
  outputSize: { width: number; height: number }
  onSubmit: (blob: Blob) => Promise<void>
  onClose: () => void
  submitLabel?: string
  children?: React.ReactNode
}

async function getCroppedBlob(
  imageSrc: string,
  crop: Area,
  outputWidth: number,
  outputHeight: number
): Promise<Blob> {
  const image = new Image()
  image.src = imageSrc
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = reject
  })

  const canvas = document.createElement('canvas')
  canvas.width = outputWidth
  canvas.height = outputHeight
  const ctx = canvas.getContext('2d')!

  ctx.drawImage(
    image,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    outputWidth,
    outputHeight
  )

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Canvas toBlob failed'))),
      'image/png'
    )
  })
}

export default function ImageCropModal({
  file,
  title,
  cropShape,
  aspect,
  outputSize,
  onSubmit,
  onClose,
  submitLabel = 'Save',
  children
}: ImageCropModalProps): React.JSX.Element {
  const [imageSrc] = useState(() => URL.createObjectURL(file))
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [croppedArea, setCroppedArea] = useState<Area | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)

  const onCropComplete = useCallback(
    (_croppedAreaPercent: Area, croppedAreaPixels: Area) => {
      setCroppedArea(croppedAreaPixels)

      const img = new Image()
      img.src = imageSrc
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = outputSize.width
        canvas.height = outputSize.height
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(
          img,
          croppedAreaPixels.x,
          croppedAreaPixels.y,
          croppedAreaPixels.width,
          croppedAreaPixels.height,
          0,
          0,
          outputSize.width,
          outputSize.height
        )
        setPreview(canvas.toDataURL('image/png'))
      }
    },
    [imageSrc, outputSize.width, outputSize.height]
  )

  const handleSubmit = async (): Promise<void> => {
    if (!croppedArea) return

    setSubmitting(true)
    setError(null)

    try {
      const blob = await getCroppedBlob(
        imageSrc,
        croppedArea,
        outputSize.width,
        outputSize.height
      )
      await onSubmit(blob)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setSubmitting(false)
    }
  }

  const isRound = cropShape === 'round'
  const previewLargeSize = isRound ? 80 : Math.min(160, outputSize.width / 2)
  const previewSmallSize = isRound ? 40 : Math.min(80, outputSize.width / 4)
  const previewLargeHeight = isRound
    ? previewLargeSize
    : previewLargeSize / aspect
  const previewSmallHeight = isRound
    ? previewSmallSize
    : previewSmallSize / aspect

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[60]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="glass-card rounded-2xl w-[48rem] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-4rem)] animate-scale-in flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-text-muted hover:text-text-primary transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Left: Cropper */}
          <div className="flex-1 flex flex-col p-6 min-w-0">
            <div
              className="relative flex-1 rounded-lg overflow-hidden min-h-[18rem]"
              style={{
                backgroundImage:
                  'linear-gradient(45deg, #2a2a2a 25%, transparent 25%), ' +
                  'linear-gradient(-45deg, #2a2a2a 25%, transparent 25%), ' +
                  'linear-gradient(45deg, transparent 75%, #2a2a2a 75%), ' +
                  'linear-gradient(-45deg, transparent 75%, #2a2a2a 75%)',
                backgroundSize: '20px 20px',
                backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px'
              }}
            >
              <Cropper
                image={imageSrc}
                crop={crop}
                zoom={zoom}
                aspect={aspect}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={onCropComplete}
                cropShape={isRound ? 'round' : 'rect'}
                showGrid={false}
              />
            </div>

            {/* Zoom controls */}
            <div className="flex items-center gap-3 mt-3">
              <ZoomOut className="w-4 h-4 text-text-muted shrink-0" />
              <input
                type="range"
                min={1}
                max={3}
                step={0.05}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="flex-1 accent-accent h-1"
              />
              <ZoomIn className="w-4 h-4 text-text-muted shrink-0" />
            </div>
          </div>

          {/* Right: Preview + extras */}
          <div className="w-64 shrink-0 border-l border-border p-6 flex flex-col gap-5">
            {/* Preview */}
            <div>
              <span className="text-text-muted text-sm font-medium block mb-2">Preview</span>
              <div className="flex items-center gap-3">
                <div
                  className={`bg-bg-base/50 border border-border flex items-center justify-center overflow-hidden ${isRound ? 'rounded-full' : 'rounded-lg'}`}
                  style={{ width: previewLargeSize, height: previewLargeHeight }}
                >
                  {preview ? (
                    <img
                      src={preview}
                      alt="preview"
                      className={`w-full h-full object-cover ${isRound ? 'rounded-full' : ''}`}
                    />
                  ) : (
                    <div className={`w-full h-full bg-bg-surface ${isRound ? 'rounded-full' : 'rounded'}`} />
                  )}
                </div>
                <div
                  className={`bg-bg-base/50 border border-border flex items-center justify-center overflow-hidden ${isRound ? 'rounded-full' : 'rounded'}`}
                  style={{ width: previewSmallSize, height: previewSmallHeight }}
                >
                  {preview ? (
                    <img
                      src={preview}
                      alt="preview-small"
                      className={`w-full h-full object-cover ${isRound ? 'rounded-full' : ''}`}
                    />
                  ) : (
                    <div className={`w-full h-full bg-bg-surface ${isRound ? 'rounded-full' : 'rounded'}`} />
                  )}
                </div>
              </div>
            </div>

            {/* Extra children (e.g. name input for emoji) */}
            {children}

            {/* Error */}
            {error && (
              <div className="text-sm text-red-400">{error}</div>
            )}

            {/* Submit */}
            <button
              type="button"
              onClick={() => {
                void handleSubmit()
              }}
              disabled={submitting || !croppedArea}
              className="mt-auto w-full px-4 py-2.5 glow-accent hover:glow-accent-hover disabled:opacity-40 disabled:shadow-none text-bg-base rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Saving...
                </>
              ) : (
                submitLabel
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
