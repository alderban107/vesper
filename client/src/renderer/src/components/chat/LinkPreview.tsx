// TODO (Phase 6.2): Sender-side link previews — currently the server fetches
// link metadata on behalf of the client (server sees the URLs in plaintext).
// For full E2EE, the sender should fetch preview metadata client-side, embed it
// in the encrypted message payload, and recipients render from the decrypted
// payload. This requires: client-side URL fetching (CORS proxy or Electron net),
// user opt-in settings, payload format extension, and abuse prevention.
import { useState, useEffect } from 'react'
import { ExternalLink } from 'lucide-react'
import { apiFetch } from '../../api/client'

interface PreviewData {
  url: string
  title: string | null
  description: string | null
  image_url: string | null
  site_name: string | null
}

// Module-level cache to avoid re-fetching
const previewCache = new Map<string, PreviewData | null>()

interface Props {
  url: string
}

export default function LinkPreview({ url }: Props): React.JSX.Element | null {
  const [preview, setPreview] = useState<PreviewData | null>(previewCache.get(url) ?? null)
  const [loading, setLoading] = useState(!previewCache.has(url))
  const [error, setError] = useState(false)

  useEffect(() => {
    if (previewCache.has(url)) {
      setPreview(previewCache.get(url) ?? null)
      setLoading(false)
      return
    }

    let cancelled = false

    const fetchPreview = async (): Promise<void> => {
      try {
        const res = await apiFetch('/api/v1/link-preview', {
          method: 'POST',
          body: JSON.stringify({ url })
        })
        if (res.ok && !cancelled) {
          const data = await res.json()
          previewCache.set(url, data.preview)
          setPreview(data.preview)
        } else if (!cancelled) {
          previewCache.set(url, null)
          setError(true)
        }
      } catch {
        if (!cancelled) {
          previewCache.set(url, null)
          setError(true)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchPreview()
    return () => { cancelled = true }
  }, [url])

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
      {preview.image_url && (
        <img
          src={preview.image_url}
          alt=""
          className="mt-2 rounded-md max-h-32 object-cover"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
      )}
    </div>
  )
}
