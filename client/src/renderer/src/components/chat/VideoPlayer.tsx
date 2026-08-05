import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Download, Film, Loader2, Play } from 'lucide-react'
import type { FileAttachment } from '@vesper/sdk/crypto'
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDuration(seconds: number): string {
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`
  }
  return `${m}:${sec.toString().padStart(2, '0')}`
}

type VideoState = 'unloaded' | 'loading' | 'loaded' | 'error'

interface VideoPlayerProps {
  file: FileAttachment
  contentType: string
}

export default function VideoPlayer({
  file,
  contentType
}: VideoPlayerProps): React.JSX.Element {
  const { id: fileId, name, size, duration, thumbnail } = file
  const thumbnailId = thumbnail?.id
  const [state, setState] = useState<VideoState>('unloaded')
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [posterUrl, setPosterUrl] = useState<string | null>(null)
  const videoCacheKey = `attachment-video:${fileId}`
  const posterCacheKey = thumbnailId ? `attachment-poster:${thumbnailId}` : null
  const videoRetainedRef = useRef(false)
  const posterRetainedRef = useRef(false)
  const mediaCapabilityUrlRef = useRef<string | null>(null)

  const releaseVideoUrl = useCallback(() => {
    if (mediaCapabilityUrlRef.current) {
      void window.attachmentMedia?.release(mediaCapabilityUrlRef.current)
      mediaCapabilityUrlRef.current = null
      setBlobUrl(null)
      setState('unloaded')
    }
    if (videoRetainedRef.current) {
      releaseCachedAttachmentObjectUrl(videoCacheKey)
      videoRetainedRef.current = false
      setBlobUrl(null)
      setState('unloaded')
    }
  }, [videoCacheKey])

  const releasePosterUrl = useCallback(() => {
    if (posterRetainedRef.current && posterCacheKey) {
      releaseCachedAttachmentObjectUrl(posterCacheKey)
      posterRetainedRef.current = false
      setPosterUrl(null)
    }
  }, [posterCacheKey])

  useEffect(() => {
    const cachedVideoUrl = acquireCachedAttachmentObjectUrl(videoCacheKey)
    if (!cachedVideoUrl) {
      return
    }

    videoRetainedRef.current = true
    setBlobUrl(cachedVideoUrl)
    setState('loaded')

    return () => {
      releaseVideoUrl()
    }
  }, [videoCacheKey, releaseVideoUrl])

  // Eagerly fetch/decrypt the tiny thumbnail JPEG
  useEffect(() => {
    if (!thumbnail || !posterCacheKey) return

    let cancelled = false
    const cachedPosterUrl = acquireCachedAttachmentObjectUrl(posterCacheKey)
    if (cachedPosterUrl) {
      posterRetainedRef.current = true
      setPosterUrl(cachedPosterUrl)

      return () => {
        releasePosterUrl()
      }
    }

    posterRetainedRef.current = true
    void loadCachedAttachmentObjectUrl(posterCacheKey, async () => {
      return await loadDecryptedAttachmentBlob(thumbnail, 'image/jpeg')
    })
      .then((url) => {
        if (cancelled) return
        setPosterUrl(url)
      })
      .catch(() => {
        // Thumbnail fetch failed — no poster, not critical
      })

    return () => {
      cancelled = true
      releasePosterUrl()
    }
  }, [thumbnail, thumbnailId, posterCacheKey, releasePosterUrl])

  const fetchAndDecrypt = async (): Promise<void> => {
    if ((videoRetainedRef.current || mediaCapabilityUrlRef.current) && blobUrl) {
      setState('loaded')
      return
    }

    setState('loading')

    try {
      if (isStreamableAttachment(file) && window.attachmentMedia) {
        const client = getRendererClient()
        const accessToken = client.getSessionStore().getAccessToken()
        if (!accessToken) throw new Error('attachment media session is unavailable')
        const url = await window.attachmentMedia.register({
          attachmentId: file.id,
          serverUrl: client.getServerUrl(),
          accessToken,
          contentType,
          plaintextSize: file.size,
          encryption: file.encryption
        })
        mediaCapabilityUrlRef.current = url
        setBlobUrl(url)
        setState('loaded')
        return
      }

      if (isStreamableAttachment(file) && file.size > 8 * 1024 * 1024) {
        throw new Error('large video streaming requires the desktop app')
      }

      videoRetainedRef.current = true
      const url = await loadCachedAttachmentObjectUrl(videoCacheKey, async () =>
        await loadDecryptedAttachmentBlob(file, contentType)
      )
      setBlobUrl(url)
      setState('loaded')
    } catch {
      if (videoRetainedRef.current) {
        releaseCachedAttachmentObjectUrl(videoCacheKey)
        videoRetainedRef.current = false
      }
      setState('error')
    }
  }

  const handleDownload = async (): Promise<void> => {
    try {
      await saveDecryptedAttachment(file, contentType)
    } catch {
      setState('error')
    }
  }

  useEffect(() => {
    return () => {
      releaseVideoUrl()
      releasePosterUrl()
    }
  }, [releasePosterUrl, releaseVideoUrl])

  if (state === 'error') {
    return (
      <div data-testid="attachment" className="vesper-video-preview">
        <div className="vesper-video-error">
          <div className="vesper-video-error-message">
            <AlertCircle className="w-4 h-4 text-error" />
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

  // Unloaded or loading state — click-to-load card with optional poster
  return (
    <div data-testid="attachment" className="vesper-video-preview">
      {posterUrl ? (
        <button
          type="button"
          className="vesper-video-poster-card"
          onClick={() => void fetchAndDecrypt()}
          disabled={state === 'loading'}
        >
          <img src={posterUrl} alt="" className="vesper-video-poster-img" />
          <span className="vesper-video-poster-overlay">
            {state === 'loading' ? (
              <span className="vesper-video-poster-spinner">
                <Loader2 className="w-8 h-8 animate-spin" />
              </span>
            ) : (
              <span className="vesper-video-poster-play">
                <Play className="w-6 h-6" />
              </span>
            )}
          </span>
          {duration != null && (
            <span className="vesper-video-duration-badge">
              {formatDuration(duration)}
            </span>
          )}
        </button>
      ) : (
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
            <span className="vesper-file-card-meta">
              {formatSize(size)}
              {duration != null && ` · ${formatDuration(duration)}`}
            </span>
          </span>
          <span className="vesper-video-card-action">
            {state === 'loading' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
          </span>
        </button>
      )}
    </div>
  )
}
