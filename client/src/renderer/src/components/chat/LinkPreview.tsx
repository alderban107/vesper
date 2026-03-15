import { useState, useEffect } from 'react'
import { ExternalLink } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { fetchLinkPreviewMetadata, type LinkPreviewData } from '../../lib/linkPreview'

// Module-level cache to avoid re-fetching
const previewCache = new Map<string, LinkPreviewData | null>()

interface Props {
  url: string
}

export default function LinkPreview({ url }: Props): React.JSX.Element | null {
  const linkPreviewsEnabled = useSettingsStore((s) => s.linkPreviewsEnabled)
  const [preview, setPreview] = useState<LinkPreviewData | null>(previewCache.get(url) ?? null)
  const [loading, setLoading] = useState(linkPreviewsEnabled && !previewCache.has(url))
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!linkPreviewsEnabled) {
      setPreview(null)
      setLoading(false)
      setError(false)
      return
    }

    if (previewCache.has(url)) {
      setPreview(previewCache.get(url) ?? null)
      setLoading(false)
      setError(previewCache.get(url) === null)
      return
    }

    let cancelled = false

    const fetchPreview = async (): Promise<void> => {
      setLoading(true)
      setError(false)

      try {
        const data = await fetchLinkPreviewMetadata(url)
        if (!cancelled) {
          previewCache.set(url, data)
          setPreview(data)
          setError(data === null)
        }
      } catch {
        if (!cancelled) {
          previewCache.set(url, null)
          setError(true)
          setPreview(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchPreview()
    return () => {
      cancelled = true
    }
  }, [linkPreviewsEnabled, url])

  if (loading) return null
  if (error || !preview || (!preview.title && !preview.description)) return null

  return (
    <div className="glass-card rounded-lg p-3 mt-1.5 max-w-md border-l-2 border-accent/50">
      {preview.site_name && (
        <div className="text-text-faintest text-[10px] uppercase tracking-wider mb-0.5">
          {preview.site_name}
        </div>
      )}
      {preview.title && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-text text-sm font-medium hover:underline flex items-center gap-1"
        >
          {preview.title}
          <ExternalLink className="w-3 h-3 shrink-0" />
        </a>
      )}
      {preview.description && (
        <p className="text-text-muted text-xs mt-0.5 line-clamp-2">
          {preview.description}
        </p>
      )}
    </div>
  )
}
