// Self-hosted twemoji SVGs served from public/twemoji/ (copied from twemoji-emojis on postinstall)
const TWEMOJI_BASE = '/twemoji'

/**
 * Convert a Unicode emoji string to hyphen-joined hex codepoints matching
 * the twemoji-emojis v14 filename convention:
 *
 *   - Standalone emojis: FE0F stripped entirely ("❤️" → "2764")
 *   - ZWJ sequences: FE0F kept where present ("❤️‍🔥" → "2764-fe0f-200d-1f525")
 *   - Skin tones: kept as-is ("👍🏽" → "1f44d-1f3fd")
 */
export function emojiToCodepoints(emoji: string): string {
  const raw = [...emoji].map((ch) => ch.codePointAt(0)!)

  // Check if this is a multi-codepoint sequence (has ZWJ, skin tones, flags, etc.)
  const hasZwj = raw.includes(0x200d)

  if (hasZwj) {
    // ZWJ sequences: keep FE0F in place — filenames retain it
    return raw.map((cp) => cp.toString(16)).join('-')
  }

  // Non-ZWJ: strip FE0F entirely — filenames never have it for standalone emojis
  const stripped = raw.filter((cp) => cp !== 0xfe0f)
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
