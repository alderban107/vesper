import { useCallback, useState } from 'react'
import Cropper from 'react-easy-crop'
import type { Area } from 'react-easy-crop'
import { X, Loader2, ZoomIn, ZoomOut } from 'lucide-react'
import { useServerStore } from '../../stores/serverStore'

interface Props {
  file: File
  serverId: string
  onClose: () => void
}

function nameFromFile(file: File): string {
  const raw = file.name.replace(/\.[^.]+$/, '')
  const cleaned = raw
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_~-]/g, '')
    .slice(0, 32)
  return cleaned.length >= 2 ? cleaned : 'emoji'
}

async function getCroppedBlob(
  imageSrc: string,
  crop: Area,
  outputSize = 128
): Promise<Blob> {
  const image = new Image()
  image.src = imageSrc
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = reject
  })

  const canvas = document.createElement('canvas')
  canvas.width = outputSize
  canvas.height = outputSize
  const ctx = canvas.getContext('2d')!

  ctx.drawImage(
    image,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    outputSize,
    outputSize
  )

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Canvas toBlob failed'))),
      'image/png'
    )
  })
}

export default function EmojiUploadModal({ file, serverId, onClose }: Props): React.JSX.Element {
  const [imageSrc] = useState(() => URL.createObjectURL(file))
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [croppedArea, setCroppedArea] = useState<Area | null>(null)
  const [name, setName] = useState(() => nameFromFile(file))
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)

  const uploadServerEmoji = useServerStore((s) => s.uploadServerEmoji)

  const onCropComplete = useCallback((_croppedAreaPercent: Area, croppedAreaPixels: Area) => {
    setCroppedArea(croppedAreaPixels)

    // Generate a preview
    const img = new Image()
    img.src = imageSrc
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = 128
      canvas.height = 128
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(
        img,
        croppedAreaPixels.x,
        croppedAreaPixels.y,
        croppedAreaPixels.width,
        croppedAreaPixels.height,
        0, 0, 128, 128
      )
      setPreview(canvas.toDataURL('image/png'))
    }
  }, [imageSrc])

  const handleSubmit = async (): Promise<void> => {
    if (!croppedArea || !name.trim()) return

    setUploading(true)
    setError(null)

    try {
      const blob = await getCroppedBlob(imageSrc, croppedArea)
      const croppedFile = new File([blob], `${name}.png`, { type: 'image/png' })
      const result = await uploadServerEmoji(serverId, croppedFile, name.trim())
      if (result) {
        onClose()
      } else {
        setError('Upload failed')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const validName = /^[a-zA-Z0-9_~-]{2,32}$/.test(name)

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
          <h2 className="text-lg font-semibold text-text-primary">Add Emoji</h2>
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
                aspect={1}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={onCropComplete}
                cropShape="rect"
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

          {/* Right: Preview + Name */}
          <div className="w-64 shrink-0 border-l border-border p-6 flex flex-col gap-5">
            {/* Preview */}
            <div>
              <span className="text-text-muted text-sm font-medium block mb-2">Preview</span>
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-lg bg-bg-base/50 border border-border flex items-center justify-center overflow-hidden">
                  {preview ? (
                    <img src={preview} alt="preview" className="w-10 h-10 object-contain" />
                  ) : (
                    <div className="w-10 h-10 bg-bg-surface rounded" />
                  )}
                </div>
                <div className="w-8 h-8 rounded bg-bg-base/50 border border-border flex items-center justify-center overflow-hidden">
                  {preview ? (
                    <img src={preview} alt="preview-small" className="w-6 h-6 object-contain" />
                  ) : (
                    <div className="w-6 h-6 bg-bg-surface rounded" />
                  )}
                </div>
              </div>
            </div>

            {/* Name */}
            <label className="block">
              <span className="text-text-muted text-sm font-medium">
                Emoji name <span className="text-red-400">*</span>
              </span>
              <div className="relative mt-1">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="emoji_name"
                  maxLength={32}
                  className="block w-full rounded-lg bg-bg-base/50 border border-border text-text-primary px-3 py-2.5 pr-8 input-focus text-sm"
                  autoFocus
                />
                {name && (
                  <button
                    type="button"
                    onClick={() => setName('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
              {name && !validName && (
                <span className="text-xs text-red-400 mt-1 block">
                  2-32 characters: letters, numbers, _ ~ -
                </span>
              )}
            </label>

            {/* Error */}
            {error && (
              <div className="text-sm text-red-400">{error}</div>
            )}

            {/* Submit */}
            <button
              type="button"
              onClick={() => { void handleSubmit() }}
              disabled={uploading || !validName || !croppedArea}
              className="mt-auto w-full px-4 py-2.5 glow-accent hover:glow-accent-hover disabled:opacity-40 disabled:shadow-none text-bg-base rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2"
            >
              {uploading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Uploading...
                </>
              ) : (
                'Finish'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
