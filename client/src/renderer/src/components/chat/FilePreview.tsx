import { useState, useEffect } from 'react'
import { Paperclip, Download, AlertCircle, Loader2 } from 'lucide-react'
import { apiFetch } from '../../api/client'
import { decryptFile } from '../../crypto/fileEncryption'
import type { FileMessageContent } from '../../stores/messageStore'

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
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!isImage) return

    let cancelled = false
    setLoading(true)

    apiFetch(`/api/v1/attachments/${file.id}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('fetch failed')
        const encryptedBlob = await res.arrayBuffer()
        const decrypted = await decryptFile(encryptedBlob, file.key, file.iv)
        if (cancelled) return
        const blob = new Blob([decrypted], { type: file.content_type })
        setImageUrl(URL.createObjectURL(blob))
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return (): void => {
      cancelled = true
      if (imageUrl) URL.revokeObjectURL(imageUrl)
    }
    // Only run on mount / file.id change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id])

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
      <div className="flex items-center gap-2 px-3 py-2 bg-bg-tertiary/50 rounded-lg text-xs text-text-faint border border-border mt-1.5">
        <AlertCircle className="w-4 h-4 text-red-400" />
        <span>File expired or unavailable</span>
      </div>
    )
  }

  // Image preview
  if (isImage) {
    return (
      <div className="mt-1.5">
        {loading ? (
          <div className="w-48 h-32 rounded-lg bg-bg-tertiary/50 border border-border flex items-center justify-center">
            <Loader2 className="w-5 h-5 text-text-faint animate-spin" />
          </div>
        ) : imageUrl ? (
          <button onClick={handleDownload} className="block group">
            <img
              src={imageUrl}
              alt={file.name}
              className="max-w-sm max-h-80 rounded-lg border border-border object-contain cursor-pointer group-hover:brightness-90 transition-all"
              onError={() => setError(true)}
            />
          </button>
        ) : null}
      </div>
    )
  }

  // Generic file download card
  return (
    <button
      onClick={handleDownload}
      className="flex items-center gap-2.5 px-3 py-2 bg-bg-tertiary/50 rounded-lg text-xs text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors border border-border mt-1.5 group"
    >
      <Paperclip className="w-4 h-4 shrink-0" />
      <span className="truncate max-w-[200px]">{file.name}</span>
      <span className="text-text-faintest">{formatSize(file.size)}</span>
      <Download className="w-3.5 h-3.5 ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
    </button>
  )
}
