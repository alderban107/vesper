/**
 * Maps file extensions to MIME types for media files.
 * Used as a fallback when File.type is empty or 'application/octet-stream'.
 */
const EXT_TO_MIME: Record<string, string> = {
  // Video
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  // Audio
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.weba': 'audio/webm',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  // Image
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif'
}

/**
 * Resolve a usable MIME type for a file. Returns the provided content_type
 * if it looks valid (not empty / not generic). Otherwise, sniffs from the
 * file extension. Falls back to the original value if nothing matches.
 */
export function resolveContentType(contentType: string, filename: string): string {
  const dominated = !contentType || contentType === 'application/octet-stream'
  if (!dominated) return contentType

  const dot = filename.lastIndexOf('.')
  if (dot === -1) return contentType || 'application/octet-stream'

  const ext = filename.slice(dot).toLowerCase()
  return EXT_TO_MIME[ext] || contentType || 'application/octet-stream'
}
