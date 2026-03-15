export interface LinkPreviewData {
  url: string
  title: string | null
  description: string | null
  image_url: string | null
  site_name: string | null
}

const MAX_TEXT_LENGTH = 280

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x27;/gi, "'")
}

function normalizeText(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }

  const normalized = decodeHtmlEntities(value).replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return null
  }

  return normalized.slice(0, MAX_TEXT_LENGTH)
}

function extractMetaTag(html: string, attribute: 'property' | 'name', name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    new RegExp(
      `<meta[^>]+${attribute}=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      'i'
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+${attribute}=["']${escaped}["'][^>]*>`,
      'i'
    )
  ]

  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match?.[1]) {
      return match[1]
    }
  }

  return null
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  return match?.[1] ?? null
}

function isIpv4Private(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!match) {
    return false
  }

  const [a, b] = match.slice(1).map(Number)
  if ([a, b].some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true
  }

  if (a === 10 || a === 127 || a === 0) {
    return true
  }

  if (a === 169 && b === 254) {
    return true
  }

  if (a === 172 && b >= 16 && b <= 31) {
    return true
  }

  if (a === 192 && b === 168) {
    return true
  }

  return false
}

export function isBlockedLinkPreviewHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase()
  if (!normalized) {
    return true
  }

  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized === '::1'
  ) {
    return true
  }

  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    return isBlockedLinkPreviewHostname(normalized.slice(1, -1))
  }

  if (normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true
  }

  if (isIpv4Private(normalized)) {
    return true
  }

  return false
}

export function isBlockedLinkPreviewUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return true
    }

    return isBlockedLinkPreviewHostname(url.hostname)
  } catch {
    return true
  }
}

export function parseLinkPreview(html: string, pageUrl: string): LinkPreviewData | null {
  const title = normalizeText(extractMetaTag(html, 'property', 'og:title') ?? extractTitle(html))
  const description = normalizeText(
    extractMetaTag(html, 'property', 'og:description') ?? extractMetaTag(html, 'name', 'description')
  )
  const siteName = normalizeText(extractMetaTag(html, 'property', 'og:site_name'))
  const imageUrlRaw = normalizeText(extractMetaTag(html, 'property', 'og:image'))

  let imageUrl: string | null = null
  if (imageUrlRaw) {
    try {
      imageUrl = new URL(imageUrlRaw, pageUrl).toString()
    } catch {
      imageUrl = null
    }
  }

  if (!title && !description) {
    return null
  }

  return {
    url: pageUrl,
    title,
    description,
    image_url: imageUrl,
    site_name: siteName
  }
}
