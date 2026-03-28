/**
 * Strip EXIF and other metadata from an image file by re-encoding
 * it through a canvas. The canvas drawImage + toBlob pipeline
 * produces a clean image with no metadata.
 *
 * Preserves the original dimensions and uses the same MIME type.
 * Falls back to the original file if re-encoding fails.
 */
export async function stripExifData(file: File): Promise<File> {
  // Only strip from JPEG and WebP — PNG/GIF don't typically have EXIF
  if (!file.type.match(/^image\/(jpeg|webp)$/)) {
    return file
  }

  try {
    const bitmap = await createImageBitmap(file)
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return file

    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()

    const blob = await canvas.convertToBlob({
      type: file.type,
      quality: file.type === 'image/jpeg' ? 0.92 : undefined,
    })

    return new File([blob], file.name, { type: file.type })
  } catch {
    return file
  }
}
