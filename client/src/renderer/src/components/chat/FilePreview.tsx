import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Download, FileText, Loader2, Paperclip, Play, Volume2 } from 'lucide-react'
import { apiFetch } from '../../api/client'
import { decryptFile } from '../../crypto/fileEncryption'
import { useVisibility } from '../../hooks/useVisibility'
import type { FileMessageContent } from '../../stores/messageStore'
import { resolveContentType } from '../../utils/mimeSniff'
import AudioPlayer from './AudioPlayer'
import ImageLightbox from './ImageLightbox'
import VideoPlayer from './VideoPlayer'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const rounded = Math.floor(seconds)
  const minutes = Math.floor(rounded / 60)
  const remainder = rounded % 60
  return `${minutes}:${remainder.toString().padStart(2, '0')}`
}

interface Props {
  file: FileMessageContent['file']
}

export default function FilePreview({ file }: Props): React.JSX.Element {
  const effectiveType = resolveContentType(file.content_type, file.name)
  const isImage = effectiveType.startsWith('image/')
  const isAudio = effectiveType.startsWith('audio/')
  const isVideo = effectiveType.startsWith('video/')
  const isMedia = isImage || isAudio || isVideo

  const { ref: visibilityRef, hasBeenVisible, isFarAway } = useVisibility()

  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [showLightbox, setShowLightbox] = useState(false)
  // Audio: explicit click-to-load (same pattern as video)
  const [audioRequested, setAudioRequested] = useState(false)

  // Audio cover art
  const [coverUrl, setCoverUrl] = useState<string | null>(null)
  const coverUrlRef = useRef<string | null>(null)

  // Track the blob URL in a ref so cleanup doesn't depend on stale state
  const blobUrlRef = useRef<string | null>(null)

  const revokeUrl = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current)
      blobUrlRef.current = null
      setPreviewUrl(null)
    }
  }, [])

  // Image: auto-fetch when visible. Audio: fetch only after explicit click.
  useEffect(() => {
    if (!isImage || !hasBeenVisible) return
    if (blobUrlRef.current) return // already loaded

    let cancelled = false
    setLoading(true)
    setError(false)

    void apiFetch(`/api/v1/attachments/${file.id}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('fetch failed')
        const encrypted = await res.arrayBuffer()
        const decrypted = await decryptFile(encrypted, file.key, file.iv)
        if (cancelled) return
        const blob = new Blob([decrypted], { type: effectiveType })
        const url = URL.createObjectURL(blob)
        blobUrlRef.current = url
        setPreviewUrl(url)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [isImage, hasBeenVisible, file.id, file.key, file.iv, effectiveType])

  // Audio: fetch when explicitly requested
  useEffect(() => {
    if (!isAudio || !audioRequested) return
    if (blobUrlRef.current) return

    let cancelled = false
    setLoading(true)
    setError(false)

    void apiFetch(`/api/v1/attachments/${file.id}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('fetch failed')
        const encrypted = await res.arrayBuffer()
        const decrypted = await decryptFile(encrypted, file.key, file.iv)
        if (cancelled) return
        const blob = new Blob([decrypted], { type: effectiveType })
        const url = URL.createObjectURL(blob)
        blobUrlRef.current = url
        setPreviewUrl(url)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [isAudio, audioRequested, file.id, file.key, file.iv, effectiveType])

  // Memory eviction: revoke blob URLs for images that scroll far away
  useEffect(() => {
    if (isImage && isFarAway && blobUrlRef.current) {
      revokeUrl()
    }
  }, [isImage, isFarAway, revokeUrl])

  // Audio: eagerly fetch and decrypt cover art thumbnail when available
  const audioMeta = isAudio ? file.audio_metadata : undefined
  useEffect(() => {
    const cover = audioMeta?.cover
    if (!cover) return
    if (coverUrlRef.current) return

    let cancelled = false
    void apiFetch(`/api/v1/attachments/${cover.id}`)
      .then(async (res) => {
        if (!res.ok) return
        const encrypted = await res.arrayBuffer()
        const decrypted = await decryptFile(encrypted, cover.key, cover.iv)
        if (cancelled) return
        const blob = new Blob([decrypted], { type: 'image/jpeg' })
        const url = URL.createObjectURL(blob)
        coverUrlRef.current = url
        setCoverUrl(url)
      })
      .catch(() => {
        // Cover art fetch failed — audio still plays without it
      })

    return () => {
      cancelled = true
    }
  }, [audioMeta?.cover])

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      revokeUrl()
      if (coverUrlRef.current) {
        URL.revokeObjectURL(coverUrlRef.current)
        coverUrlRef.current = null
      }
    }
  }, [revokeUrl])

  const handleDownload = async (): Promise<void> => {
    try {
      const res = await apiFetch(`/api/v1/attachments/${file.id}`)
      if (!res.ok) {
        setError(true)
        return
      }
      const encryptedBlob = await res.arrayBuffer()
      const decrypted = await decryptFile(encryptedBlob, file.key, file.iv)
      const blob = new Blob([decrypted], { type: effectiveType })
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

  // Video: delegate to VideoPlayer (always click-to-load)
  if (isVideo) {
    return (
      <div ref={isMedia ? visibilityRef : undefined}>
        <VideoPlayer
          fileId={file.id}
          name={file.name}
          contentType={effectiveType}
          size={file.size}
          encryptionKey={file.key}
          iv={file.iv}
          thumbnailId={file.thumbnail?.id}
          thumbnailKey={file.thumbnail?.key}
          thumbnailIv={file.thumbnail?.iv}
          duration={file.duration}
        />
      </div>
    )
  }

  // Image preview — gated by visibility
  if (isImage) {
    return (
      <div ref={visibilityRef} data-testid="attachment" className="mt-1.5">
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
        ) : !hasBeenVisible ? (
          // Placeholder before the element scrolls into view
          <div className="w-48 h-32 rounded-lg bg-bg-tertiary/50 border border-border" />
        ) : null}
      </div>
    )
  }

  // Audio: click-to-load card, then AudioPlayer
  if (isAudio) {
    const metaTitle = audioMeta?.title
    const metaArtist = audioMeta?.artist
    const displayName = metaTitle || file.name
    const displaySub = metaArtist
      ? metaArtist
      : file.duration
        ? `${formatSize(file.size)} · ${formatDuration(file.duration)}`
        : formatSize(file.size)

    return (
      <div ref={visibilityRef} data-testid="attachment" className="vesper-audio-preview">
        {!audioRequested && !previewUrl ? (
          // Unloaded state — show card with play button and optional metadata
          <button
            type="button"
            className="vesper-audio-unloaded-card"
            onClick={() => setAudioRequested(true)}
          >
            {coverUrl ? (
              <img
                src={coverUrl}
                alt="Album art"
                className="vesper-audio-cover-thumb"
              />
            ) : (
              <span className="vesper-audio-preview-icon">
                <Volume2 className="w-4 h-4" />
              </span>
            )}
            <span className="vesper-file-card-copy">
              <span className="vesper-file-card-name">{displayName}</span>
              <span className="vesper-file-card-meta">{displaySub}</span>
            </span>
            <span className="vesper-audio-card-action">
              <Play className="w-4 h-4" />
            </span>
          </button>
        ) : loading ? (
          <div className="vesper-audio-preview-loading">
            <Loader2 className="w-4 h-4 text-text-faint animate-spin" />
            <span>Decrypting audio…</span>
          </div>
        ) : previewUrl ? (
          <AudioPlayer
            src={previewUrl}
            name={file.name}
            sizeLabel={formatSize(file.size)}
            onDownload={() => {
              void handleDownload()
            }}
            coverUrl={coverUrl || undefined}
            title={metaTitle}
            artist={metaArtist}
          />
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
        {effectiveType ? <FileText className="w-4 h-4" /> : <Paperclip className="w-4 h-4" />}
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
