// Self-hosted twemoji SVGs served from public/twemoji/ (copied from twemoji-emojis on postinstall)
const TWEMOJI_BASE = '/twemoji'

// Codepoints below this threshold that appear alone are "text-presentation-by-default"
// and need FE0F to map to the correct twemoji filename (e.g. red heart 2764-fe0f).
const TEXT_PRESENTATION_THRESHOLD = 0x1f000

/**
 * Convert a Unicode emoji string to hyphen-joined hex codepoints.
 * Handles surrogates, ZWJ sequences, and FE0F variation selector stripping.
 *
 *   "😄"        → "1f604"
 *   "🇺🇸"      → "1f1fa-1f1f8"
 *   "❤️"        → "2764-fe0f"
 *   "👨‍👩‍👧"  → "1f468-200d-1f469-200d-1f467"
 */
export function emojiToCodepoints(emoji: string): string {
  const raw = [...emoji].map((ch) => ch.codePointAt(0)!)

  // Strip FE0F
  const stripped = raw.filter((cp) => cp !== 0xfe0f)

  // If stripping FE0F left a single codepoint below the threshold,
  // the file needs FE0F (text-presentation-by-default characters like ❤️).
  if (stripped.length === 1 && stripped[0] < TEXT_PRESENTATION_THRESHOLD) {
    return stripped[0].toString(16) + '-fe0f'
  }

  const points = stripped.length > 0 ? stripped : raw
  return points.map((cp) => cp.toString(16)).join('-')
}

/**
 * Get the local twemoji SVG URL for a Unicode emoji.
 * Returns null for empty strings.
 */
export function emojiToTwemojiUrl(emoji: string): string | null {
  if (!emoji) return null
  return `${TWEMOJI_BASE}/${emojiToCodepoints(emoji)}.svg`
}

/**
 * Replace a failed twemoji <img> with the native Unicode glyph.
 * Attach this to onError on twemoji img elements.
 */
export function twemojiFallback(e: React.SyntheticEvent<HTMLImageElement>): void {
  const img = e.currentTarget
  const text = img.alt
  if (!text) return
  const span = document.createElement('span')
  span.className = 'vesper-emoji-text'
  span.setAttribute('aria-hidden', 'true')
  span.textContent = text
  img.replaceWith(span)
}
