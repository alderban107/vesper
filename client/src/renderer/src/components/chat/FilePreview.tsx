import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Download, FileText, Loader2, Paperclip, Play, Volume2 } from 'lucide-react'
import { useVisibility } from '../../hooks/useVisibility'
import type { FileMessageContent } from '../../stores/messageStore'
import {
  useAttachmentTransferStore,
  type AttachmentTransferErrorKind
} from '../../stores/attachmentTransferStore'
import {
  isStreamableAttachment,
  loadDecryptedAttachmentBlob,
  saveDecryptedAttachment
} from '../../utils/attachmentTransfer'
import { getRendererClient } from '../../sdk/client'
import {
  acquireCachedAttachmentObjectUrl,
  loadCachedAttachmentObjectUrl,
  releaseCachedAttachmentObjectUrl
} from '../../utils/attachmentObjectUrlCache'
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

class AttachmentDisplayError extends Error {
  readonly kind: AttachmentTransferErrorKind

  constructor(kind: AttachmentTransferErrorKind) {
    super(kind)
    this.name = 'AttachmentDisplayError'
    this.kind = kind
  }
}

function attachmentFetchErrorKind(error: unknown): AttachmentTransferErrorKind {
  const message = error instanceof Error ? error.message : String(error)
  const statusMatch = /status (\d+)/.exec(message)
  const status = statusMatch ? Number.parseInt(statusMatch[1] ?? '', 10) : null

  if (status === 403 || status === 404 || status === 410) {
    return 'unavailable'
  }

  return 'network'
}

async function loadDecryptedAttachment(
  file: FileMessageContent['file'],
  contentType: string
): Promise<Blob> {
  try {
    return await loadDecryptedAttachmentBlob(file, contentType)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/status \d+/.test(message) || error instanceof TypeError) {
      throw new AttachmentDisplayError(attachmentFetchErrorKind(error))
    }
    throw new AttachmentDisplayError('integrity')
  }
}

function attachmentErrorMessage(error: AttachmentTransferErrorKind): string {
  if (error === 'network') return 'Could not download file. Check your connection.'
  if (error === 'integrity') return 'File could not be decrypted.'
  if (error === 'unsupported') return 'This large file needs the desktop app or a browser with streaming file saves.'
  return 'File expired or unavailable.'
}

interface Props {
  file: FileMessageContent['file']
}

export default function FilePreview({ file }: Props): React.JSX.Element {
  const effectiveType = resolveContentType(file.content_type, file.name)
  const isImage = effectiveType.startsWith('image/')
  const isInlineImage = isImage && file.size <= 16 * 1024 * 1024
  const isAudio = effectiveType.startsWith('audio/')
  const isVideo = effectiveType.startsWith('video/')
  const isMedia = isImage || isAudio || isVideo
  const isSpoiler = file.name.startsWith('SPOILER_')
  const [spoilerRevealed, setSpoilerRevealed] = useState(false)

  const { ref: visibilityRef, hasBeenVisible, isFarAway } = useVisibility()

  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const error = useAttachmentTransferStore(
    (state) => state.errorsByAttachmentId[file.id] ?? null
  )
  const setStoredError = useAttachmentTransferStore((state) => state.setError)
  const clearStoredError = useAttachmentTransferStore((state) => state.clearError)
  const setError = useCallback((nextError: AttachmentTransferErrorKind | null) => {
    if (nextError) setStoredError(file.id, nextError)
    else clearStoredError(file.id)
  }, [clearStoredError, file.id, setStoredError])
  const [retryVersion, setRetryVersion] = useState(0)
  const [showLightbox, setShowLightbox] = useState(false)
  // Audio: explicit click-to-load (same pattern as video)
  const [audioRequested, setAudioRequested] = useState(false)

  // Audio cover art
  const [coverUrl, setCoverUrl] = useState<string | null>(null)
  const coverCacheKey = file.audio_metadata?.cover ? `attachment-cover:${file.audio_metadata.cover.id}` : null
  const coverRetainedRef = useRef(false)

  const previewCacheKey = `attachment-preview:${file.id}`
  const previewRetainedRef = useRef(false)
  const mediaCapabilityUrlRef = useRef<string | null>(null)

  const releasePreviewUrl = useCallback(() => {
    if (mediaCapabilityUrlRef.current) {
      void window.attachmentMedia?.release(mediaCapabilityUrlRef.current)
      mediaCapabilityUrlRef.current = null
      setPreviewUrl(null)
    }
    if (previewRetainedRef.current) {
      releaseCachedAttachmentObjectUrl(previewCacheKey)
      previewRetainedRef.current = false
      setPreviewUrl(null)
    }
  }, [previewCacheKey])

  const releaseCoverUrl = useCallback(() => {
    if (coverRetainedRef.current && coverCacheKey) {
      releaseCachedAttachmentObjectUrl(coverCacheKey)
      coverRetainedRef.current = false
      setCoverUrl(null)
    }
  }, [coverCacheKey])

  // Image: auto-fetch when visible. Audio: fetch only after explicit click.
  useEffect(() => {
    if (!isInlineImage || !hasBeenVisible) return
    if (previewRetainedRef.current) return

    let cancelled = false
    const cachedUrl = acquireCachedAttachmentObjectUrl(previewCacheKey)
    if (cachedUrl) {
      previewRetainedRef.current = true
      setError(null)
      setLoading(false)
      setPreviewUrl(cachedUrl)

      return () => {
        releasePreviewUrl()
      }
    }

    setLoading(true)
    setError(null)
    previewRetainedRef.current = true

    void loadCachedAttachmentObjectUrl(
      previewCacheKey,
      async () => await loadDecryptedAttachment(file, effectiveType)
    )
      .then((url) => {
        if (cancelled) return
        setPreviewUrl(url)
      })
      .catch((loadError) => {
        if (!cancelled) {
          previewRetainedRef.current = false
          setError(loadError instanceof AttachmentDisplayError ? loadError.kind : 'network')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
      releasePreviewUrl()
    }
  }, [isInlineImage, hasBeenVisible, file, effectiveType, previewCacheKey, releasePreviewUrl, retryVersion])

  // Audio: fetch when explicitly requested
  useEffect(() => {
    if (!isAudio || !audioRequested) return
    if (previewRetainedRef.current || mediaCapabilityUrlRef.current) return

    let cancelled = false

    if (isStreamableAttachment(file) && window.attachmentMedia) {
      setLoading(true)
      setError(null)
      const client = getRendererClient()
      const accessToken = client.getSessionStore().getAccessToken()
      if (!accessToken) {
        setLoading(false)
        setError('unavailable')
        return
      }

      void window.attachmentMedia.register({
        attachmentId: file.id,
        serverUrl: client.getServerUrl(),
        accessToken,
        contentType: effectiveType,
        plaintextSize: file.size,
        encryption: file.encryption
      }).then((url) => {
        if (cancelled) {
          void window.attachmentMedia?.release(url)
          return
        }
        mediaCapabilityUrlRef.current = url
        setPreviewUrl(url)
      }).catch(() => {
        if (!cancelled) setError('network')
      }).finally(() => {
        if (!cancelled) setLoading(false)
      })

      return () => {
        cancelled = true
        releasePreviewUrl()
      }
    }

    if (isStreamableAttachment(file) && file.size > 8 * 1024 * 1024) {
      setError('unsupported')
      return
    }

    const cachedUrl = acquireCachedAttachmentObjectUrl(previewCacheKey)
    if (cachedUrl) {
      previewRetainedRef.current = true
      setError(null)
      setLoading(false)
      setPreviewUrl(cachedUrl)

      return () => {
        releasePreviewUrl()
      }
    }

    setLoading(true)
    setError(null)
    previewRetainedRef.current = true

    void loadCachedAttachmentObjectUrl(
      previewCacheKey,
      async () => await loadDecryptedAttachment(file, effectiveType)
    )
      .then((url) => {
        if (cancelled) return
        setPreviewUrl(url)
      })
      .catch((loadError) => {
        if (!cancelled) {
          previewRetainedRef.current = false
          setError(loadError instanceof AttachmentDisplayError ? loadError.kind : 'network')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
      releasePreviewUrl()
    }
  }, [isAudio, audioRequested, file, effectiveType, previewCacheKey, releasePreviewUrl, retryVersion])

  // Release the row's local hold when it scrolls far away.
  // The shared cache keeps hot previews around until LRU pressure evicts them.
  useEffect(() => {
    if (isInlineImage && isFarAway && previewRetainedRef.current) {
      releasePreviewUrl()
    }
  }, [isInlineImage, isFarAway, releasePreviewUrl])

  // Audio: eagerly fetch and decrypt cover art thumbnail when available
  const audioMeta = isAudio ? file.audio_metadata : undefined
  useEffect(() => {
    const cover = audioMeta?.cover
    if (!cover) return
    if (!coverCacheKey || coverRetainedRef.current) return

    let cancelled = false
    const cachedUrl = acquireCachedAttachmentObjectUrl(coverCacheKey)
    if (cachedUrl) {
      coverRetainedRef.current = true
      setCoverUrl(cachedUrl)

      return () => {
        releaseCoverUrl()
      }
    }

    coverRetainedRef.current = true
    void loadCachedAttachmentObjectUrl(coverCacheKey, async () => {
      return await loadDecryptedAttachmentBlob(cover, 'image/jpeg')
    })
      .then((url) => {
        if (cancelled) return
        setCoverUrl(url)
      })
      .catch(() => {
        // Cover art fetch failed — audio still plays without it
      })

    return () => {
      cancelled = true
      releaseCoverUrl()
    }
  }, [audioMeta?.cover, coverCacheKey, releaseCoverUrl])

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      releasePreviewUrl()
      releaseCoverUrl()
    }
  }, [releaseCoverUrl, releasePreviewUrl])

  const handleDownload = async (): Promise<void> => {
    setError(null)
    try {
      await saveDecryptedAttachment(file, effectiveType)
    } catch (downloadError) {
      if (downloadError instanceof DOMException && downloadError.name === 'AbortError') return
      const message = downloadError instanceof Error ? downloadError.message : ''
      setError(
        downloadError instanceof AttachmentDisplayError
          ? downloadError.kind
          : /streaming file saves|requires the desktop app/i.test(message)
            ? 'unsupported'
            : 'network'
      )
    }
  }

  const retryDownload = (): void => {
    setError(null)
    if (isImage || isAudio) {
      setRetryVersion((version) => version + 1)
      return
    }

    void handleDownload()
  }

  if (error) {
    return (
      <div data-testid="attachment" className="flex items-center gap-2 px-3 py-2 bg-bg-tertiary/50 rounded-lg text-xs text-text-faint border border-border mt-1.5">
        <AlertCircle className="w-4 h-4 text-error" />
        <span>{attachmentErrorMessage(error)}</span>
        {error === 'network' && (
          <button type="button" className="font-medium text-text hover:underline" onClick={retryDownload}>
            Retry
          </button>
        )}
      </div>
    )
  }

  // Video: delegate to VideoPlayer (always click-to-load)
  if (isVideo) {
    return (
      <div ref={isMedia ? visibilityRef : undefined} className="mt-1.5">
        {isSpoiler && !spoilerRevealed ? (
          <button
            type="button"
            onClick={() => setSpoilerRevealed(true)}
            className="vesper-file-spoiler-overlay"
          >
            <div className="w-64 h-36 rounded-lg bg-bg-tertiary/50 border border-border flex items-center justify-center">
              <span className="vesper-file-spoiler-label">SPOILER</span>
            </div>
          </button>
        ) : (
          <VideoPlayer file={file} contentType={effectiveType} />
        )}
      </div>
    )
  }

  // Image preview — gated by visibility
  if (isInlineImage) {
    return (
      <div ref={visibilityRef} data-testid="attachment" className="mt-1.5">
        {loading ? (
          <div className="w-48 h-32 rounded-lg bg-bg-tertiary/50 border border-border flex items-center justify-center">
            <Loader2 className="w-5 h-5 text-text-faint animate-spin" />
          </div>
        ) : previewUrl ? (
          <>
            {isSpoiler && !spoilerRevealed ? (
              <button
                type="button"
                onClick={() => setSpoilerRevealed(true)}
                className="vesper-file-spoiler-overlay"
              >
                <img
                  src={previewUrl}
                  alt={file.name}
                  className="max-w-sm max-h-80 rounded-lg border border-border object-contain"
                  onError={() => setError('integrity')}
                />
                <span className="vesper-file-spoiler-label">SPOILER</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => isSpoiler ? setSpoilerRevealed(false) : setShowLightbox(true)}
                className="block group"
              >
                <img
                  src={previewUrl}
                  alt={file.name}
                  className="max-w-sm max-h-80 rounded-lg border border-border object-contain cursor-zoom-in group-hover:brightness-90 transition-all"
                  onError={() => setError('integrity')}
                />
              </button>
            )}

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
