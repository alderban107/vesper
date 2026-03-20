export interface AudioMetadataResult {
  title?: string
  artist?: string
  album?: string
  duration?: number
  coverBlob?: Blob
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/**
 * Resize cover art to a max 200px long edge JPEG thumbnail.
 * Returns null if the image can't be decoded or rendered.
 */
async function resizeCoverArt(data: Uint8Array, mime: string): Promise<Blob | null> {
  const srcBlob = new Blob([data], { type: mime })
  const url = URL.createObjectURL(srcBlob)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = (): void => resolve(el)
      el.onerror = (): void => reject(new Error('image decode failed'))
      el.src = url
    })

    const maxEdge = 200
    let cw = img.naturalWidth
    let ch = img.naturalHeight
    if (!cw || !ch) return null

    if (cw > maxEdge || ch > maxEdge) {
      if (cw >= ch) {
        ch = Math.round((ch / cw) * maxEdge)
        cw = maxEdge
      } else {
        cw = Math.round((cw / ch) * maxEdge)
        ch = maxEdge
      }
    }

    const canvas = document.createElement('canvas')
    canvas.width = cw
    canvas.height = ch
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    ctx.drawImage(img, 0, 0, cw, ch)

    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(
        (blob) => resolve(blob),
        'image/jpeg',
        0.7
      )
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * Extract audio metadata (title, artist, album, duration, cover art) from a file.
 * Uses music-metadata-browser to parse ID3/Vorbis/MP4 tags.
 * Returns null if parsing fails or no metadata exists.
 */
export async function extractAudioMetadata(file: File): Promise<AudioMetadataResult | null> {
  try {
    const { parseBlob, selectCover } = await import('music-metadata-browser')
    const metadata = await parseBlob(file)

    const title = truncate(metadata.common.title, 128)
    const artist = truncate(metadata.common.artist, 128)
    const album = truncate(metadata.common.album, 256)
    const duration =
      metadata.format.duration && isFinite(metadata.format.duration) && metadata.format.duration > 0
        ? metadata.format.duration
        : undefined

    // Extract cover art — selectCover picks the front cover or first picture
    const picture = selectCover(metadata.common.picture)
    let coverBlob: Blob | undefined
    if (picture && picture.data && picture.data.length > 0) {
      const resized = await resizeCoverArt(picture.data, picture.format)
      if (resized) {
        coverBlob = resized
      }
    }

    // Return null if we got nothing useful
    if (!title && !artist && !album && !duration && !coverBlob) {
      return null
    }

    return { title, artist, album, duration, coverBlob }
  } catch {
    return null
  }
}
