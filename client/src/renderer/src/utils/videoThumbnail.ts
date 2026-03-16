/**
 * Extract a JPEG thumbnail and duration from a video file.
 * Runs entirely client-side using a temporary <video> element and <canvas>.
 * Returns null if extraction fails (e.g., unsupported codec).
 */
export async function extractVideoThumbnail(
  file: File
): Promise<{ blob: Blob; duration: number } | null> {
  const url = URL.createObjectURL(file)
  try {
    return await new Promise<{ blob: Blob; duration: number } | null>((resolve) => {
      const video = document.createElement('video')
      video.preload = 'metadata'
      video.muted = true
      // Prevent the video from being visible
      video.style.position = 'fixed'
      video.style.left = '-9999px'
      video.style.top = '-9999px'
      video.style.width = '1px'
      video.style.height = '1px'

      let resolved = false
      const done = (result: { blob: Blob; duration: number } | null): void => {
        if (resolved) return
        resolved = true
        video.pause()
        video.removeAttribute('src')
        video.load()
        resolve(result)
      }

      // Timeout — 10s is generous for metadata + seek
      const timeout = setTimeout(() => done(null), 10_000)

      video.onerror = (): void => {
        clearTimeout(timeout)
        done(null)
      }

      video.onloadedmetadata = (): void => {
        const duration = video.duration
        if (!duration || !isFinite(duration) || duration <= 0) {
          clearTimeout(timeout)
          done(null)
          return
        }

        // Seek to min(1.0, duration * 0.1)
        video.currentTime = Math.min(1.0, duration * 0.1)
      }

      video.onseeked = (): void => {
        clearTimeout(timeout)
        try {
          const vw = video.videoWidth
          const vh = video.videoHeight
          if (!vw || !vh) {
            done(null)
            return
          }

          // Cap long edge at 320px
          const maxEdge = 320
          let cw = vw
          let ch = vh
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
          if (!ctx) {
            done(null)
            return
          }

          ctx.drawImage(video, 0, 0, cw, ch)

          canvas.toBlob(
            (blob) => {
              done(blob ? { blob, duration: video.duration } : null)
            },
            'image/jpeg',
            0.7
          )
        } catch {
          done(null)
        }
      }

      video.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}
