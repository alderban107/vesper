import { useEffect, useState } from 'react'
import { AlertCircle, Download, FileText, Loader2, Paperclip } from 'lucide-react'
import { apiFetch } from '../../api/client'
import { decryptFile } from '../../crypto/fileEncryption'
import type { FileMessageContent } from '../../stores/messageStore'
import AudioPlayer from './AudioPlayer'
import ImageLightbox from './ImageLightbox'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface Props {
  file: FileMessageContent['file']
}

export default function FilePreview({ file }: Props): React.JSX.Element {
  const isImage = file.content_type.startsWith('image/')
  const isAudio = file.content_type.startsWith('audio/')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [showLightbox, setShowLightbox] = useState(false)

  useEffect(() => {
    if (!isImage && !isAudio) {
      return
    }

    let cancelled = false
    let objectUrl: string | null = null
    setLoading(true)
    setError(false)

    void apiFetch(`/api/v1/attachments/${file.id}`)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error('fetch failed')
        }
        const encryptedBlob = await res.arrayBuffer()
        const decrypted = await decryptFile(encryptedBlob, file.key, file.iv)
        if (cancelled) {
          return
        }
        const blob = new Blob([decrypted], { type: file.content_type })
        objectUrl = URL.createObjectURL(blob)
        setPreviewUrl(objectUrl)
      })
      .catch(() => {
        if (!cancelled) {
          setError(true)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return (): void => {
      cancelled = true
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [file.content_type, file.id, file.iv, file.key, isAudio, isImage])

  const handleDownload = async (): Promise<void> => {
    try {
      const res = await apiFetch(`/api/v1/attachments/${file.id}`)
      if (!res.ok) {
        setError(true)
        return
      }
      const encryptedBlob = await res.arrayBuffer()
      const decrypted = await decryptFile(encryptedBlob, file.key, file.iv)
      const blob = new Blob([decrypted], { type: file.content_type })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = file.name
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      setError(true)
    }
  }

  if (error) {
    return (
      <div data-testid="attachment" className="flex items-center gap-2 px-3 py-2 bg-bg-tertiary/50 rounded-lg text-xs text-text-faint border border-border mt-1.5">
        <AlertCircle className="w-4 h-4 text-red-400" />
        <span>File expired or unavailable</span>
      </div>
    )
  }

  // Image preview
  if (isImage) {
    return (
      <div data-testid="attachment" className="mt-1.5">
        {loading ? (
          <div className="w-48 h-32 rounded-lg bg-bg-tertiary/50 border border-border flex items-center justify-center">
            <Loader2 className="w-5 h-5 text-text-faint animate-spin" />
          </div>
        ) : previewUrl ? (
          <>
            <button
              type="button"
              onClick={() => setShowLightbox(true)}
              className="block group"
            >
              <img
                src={previewUrl}
                alt={file.name}
                className="max-w-sm max-h-80 rounded-lg border border-border object-contain cursor-zoom-in group-hover:brightness-90 transition-all"
                onError={() => setError(true)}
              />
            </button>

            {showLightbox && (
              <ImageLightbox
                src={previewUrl}
                name={file.name}
                sizeLabel={formatSize(file.size)}
                onClose={() => setShowLightbox(false)}
                onDownload={handleDownload}
              />
            )}
          </>
        ) : null}
      </div>
    )
  }

  if (isAudio) {
    return (
      <div data-testid="attachment" className="vesper-audio-preview">
        {loading ? (
          <div className="vesper-audio-preview-loading">
            <Loader2 className="w-4 h-4 text-text-faint animate-spin" />
            <span>Decrypting audio…</span>
          </div>
        ) : previewUrl ? (
          <>
            <AudioPlayer
              src={previewUrl}
              name={file.name}
              sizeLabel={formatSize(file.size)}
              onDownload={() => {
                void handleDownload()
              }}
            />
          </>
        ) : null}
      </div>
    )
  }

  // Generic file download card
  return (
    <button
      data-testid="attachment"
      onClick={handleDownload}
      className="vesper-file-card group"
    >
      <span className="vesper-file-card-icon">
        {file.content_type ? <FileText className="w-4 h-4" /> : <Paperclip className="w-4 h-4" />}
      </span>
      <span className="vesper-file-card-copy">
        <span className="vesper-file-card-name">{file.name}</span>
        <span className="vesper-file-card-meta">{formatSize(file.size)}</span>
      </span>
      <span className="vesper-file-card-download">
        <Download className="w-4 h-4" />
      </span>
    </button>
  )
}
