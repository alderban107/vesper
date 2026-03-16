import { useState } from 'react'
import { AlertCircle, Download, Film, Loader2, Play } from 'lucide-react'
import { apiFetch } from '../../api/client'
import { decryptFile } from '../../crypto/fileEncryption'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

type VideoState = 'unloaded' | 'loading' | 'loaded' | 'error'

interface VideoPlayerProps {
  fileId: string
  name: string
  contentType: string
  size: number
  encryptionKey: string
  iv: string
}

export default function VideoPlayer({
  fileId,
  name,
  contentType,
  size,
  encryptionKey,
  iv
}: VideoPlayerProps): React.JSX.Element {
  const [state, setState] = useState<VideoState>('unloaded')
  const [blobUrl, setBlobUrl] = useState<string | null>(null)

  const fetchAndDecrypt = async (): Promise<void> => {
    setState('loading')
    try {
      const res = await apiFetch(`/api/v1/attachments/${fileId}`)
      if (!res.ok) throw new Error('fetch failed')
      const encrypted = await res.arrayBuffer()
      const decrypted = await decryptFile(encrypted, encryptionKey, iv)
      const blob = new Blob([decrypted], { type: contentType })
      const url = URL.createObjectURL(blob)
      setBlobUrl(url)
      setState('loaded')
    } catch {
      setState('error')
    }
  }

  const handleDownload = async (): Promise<void> => {
    try {
      let url = blobUrl
      if (!url) {
        const res = await apiFetch(`/api/v1/attachments/${fileId}`)
        if (!res.ok) return
        const encrypted = await res.arrayBuffer()
        const decrypted = await decryptFile(encrypted, encryptionKey, iv)
        const blob = new Blob([decrypted], { type: contentType })
        url = URL.createObjectURL(blob)
      }
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      if (url !== blobUrl) URL.revokeObjectURL(url)
    } catch {
      /* download failed silently */
    }
  }

  if (state === 'error') {
    return (
      <div data-testid="attachment" className="vesper-video-preview">
        <div className="vesper-video-error">
          <div className="vesper-video-error-message">
            <AlertCircle className="w-4 h-4 text-red-400" />
            <span>Format not supported</span>
          </div>
          <button
            type="button"
            className="vesper-file-card group"
            onClick={() => void handleDownload()}
          >
            <span className="vesper-file-card-icon">
              <Film className="w-4 h-4" />
            </span>
            <span className="vesper-file-card-copy">
              <span className="vesper-file-card-name">{name}</span>
              <span className="vesper-file-card-meta">{formatSize(size)}</span>
            </span>
            <span className="vesper-file-card-download">
              <Download className="w-4 h-4" />
            </span>
          </button>
        </div>
      </div>
    )
  }

  if (state === 'loaded' && blobUrl) {
    return (
      <div data-testid="attachment" className="vesper-video-preview">
        <video
          controls
          className="vesper-video-element"
          src={blobUrl}
          onError={() => setState('error')}
        >
          <track kind="captions" />
        </video>
      </div>
    )
  }

  // Unloaded or loading state — click-to-load card
  return (
    <div data-testid="attachment" className="vesper-video-preview">
      <button
        type="button"
        className="vesper-video-card"
        onClick={() => void fetchAndDecrypt()}
        disabled={state === 'loading'}
      >
        <span className="vesper-video-card-icon">
          <Film className="w-4 h-4" />
        </span>
        <span className="vesper-file-card-copy">
          <span className="vesper-file-card-name">{name}</span>
          <span className="vesper-file-card-meta">{formatSize(size)}</span>
        </span>
        <span className="vesper-video-card-action">
          {state === 'loading' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Play className="w-4 h-4" />
          )}
        </span>
      </button>
    </div>
  )
}
