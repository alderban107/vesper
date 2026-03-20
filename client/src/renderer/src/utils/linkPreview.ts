import {
  isBlockedLinkPreviewUrl,
  parseLinkPreview,
  type LinkPreviewData
} from '../../../shared/linkPreview'

const LINK_PREVIEW_TIMEOUT_MS = 5_000
const MAX_LINK_PREVIEW_HTML_LENGTH = 524_288

async function fetchPreviewInBrowser(rawUrl: string): Promise<LinkPreviewData | null> {
  if (isBlockedLinkPreviewUrl(rawUrl)) {
    return null
  }

  try {
    const response = await fetch(rawUrl, {
      signal: AbortSignal.timeout(LINK_PREVIEW_TIMEOUT_MS),
      redirect: 'follow'
    })

    if (!response.ok) {
      return null
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      return null
    }

    const finalUrl = response.url || rawUrl
    if (isBlockedLinkPreviewUrl(finalUrl)) {
      return null
    }

    const html = (await response.text()).slice(0, MAX_LINK_PREVIEW_HTML_LENGTH)
    return parseLinkPreview(html, finalUrl)
  } catch {
    return null
  }
}

export async function fetchLinkPreviewMetadata(rawUrl: string): Promise<LinkPreviewData | null> {
  if (window.linkPreview) {
    return window.linkPreview.fetchMetadata(rawUrl)
  }

  return fetchPreviewInBrowser(rawUrl)
}

export type { LinkPreviewData }
