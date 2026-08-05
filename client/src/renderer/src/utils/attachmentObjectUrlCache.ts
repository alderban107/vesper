type BlobFactory = () => Promise<Blob>

interface CacheEntry {
  url?: string
  promise?: Promise<string>
  refCount: number
  size: number
}

const MAX_ATTACHMENT_OBJECT_URLS = 64
const MAX_ATTACHMENT_OBJECT_URL_BYTES = 64 * 1024 * 1024
const attachmentObjectUrlCache = new Map<string, CacheEntry>()

function touchEntry(cacheKey: string, entry: CacheEntry): void {
  attachmentObjectUrlCache.delete(cacheKey)
  attachmentObjectUrlCache.set(cacheKey, entry)
}

function cachedAttachmentBytes(): number {
  let total = 0
  for (const entry of attachmentObjectUrlCache.values()) total += entry.size
  return total
}

function pruneAttachmentObjectUrls(): void {
  let bytes = cachedAttachmentBytes()
  if (
    attachmentObjectUrlCache.size <= MAX_ATTACHMENT_OBJECT_URLS &&
    bytes <= MAX_ATTACHMENT_OBJECT_URL_BYTES
  ) {
    return
  }

  for (const [cacheKey, entry] of attachmentObjectUrlCache) {
    if (
      attachmentObjectUrlCache.size <= MAX_ATTACHMENT_OBJECT_URLS &&
      bytes <= MAX_ATTACHMENT_OBJECT_URL_BYTES
    ) {
      break
    }

    if (entry.refCount > 0 || !entry.url) {
      continue
    }

    URL.revokeObjectURL(entry.url)
    attachmentObjectUrlCache.delete(cacheKey)
    bytes -= entry.size
  }
}

export function acquireCachedAttachmentObjectUrl(cacheKey: string): string | null {
  const entry = attachmentObjectUrlCache.get(cacheKey)
  if (!entry?.url) {
    return null
  }

  entry.refCount += 1
  touchEntry(cacheKey, entry)
  return entry.url
}

export function releaseCachedAttachmentObjectUrl(cacheKey: string): void {
  const entry = attachmentObjectUrlCache.get(cacheKey)
  if (!entry) {
    return
  }

  entry.refCount = Math.max(0, entry.refCount - 1)
  touchEntry(cacheKey, entry)
  pruneAttachmentObjectUrls()
}

export function clearAttachmentObjectUrlCache(): void {
  for (const entry of attachmentObjectUrlCache.values()) {
    if (entry.url) {
      URL.revokeObjectURL(entry.url)
    }
  }

  attachmentObjectUrlCache.clear()
}

export async function loadCachedAttachmentObjectUrl(
  cacheKey: string,
  createBlob: BlobFactory
): Promise<string> {
  const existingEntry = attachmentObjectUrlCache.get(cacheKey)
  if (existingEntry?.url) {
    existingEntry.refCount += 1
    touchEntry(cacheKey, existingEntry)
    return existingEntry.url
  }

  if (existingEntry?.promise) {
    existingEntry.refCount += 1
    touchEntry(cacheKey, existingEntry)
    return existingEntry.promise
  }

  const entry: CacheEntry = {
    refCount: 1,
    size: 0
  }

  entry.promise = createBlob()
    .then((blob) => {
      const url = URL.createObjectURL(blob)
      const currentEntry = attachmentObjectUrlCache.get(cacheKey)
      if (!currentEntry) {
        URL.revokeObjectURL(url)
        throw new Error('attachment cache entry disappeared')
      }

      currentEntry.url = url
      currentEntry.promise = undefined
      currentEntry.size = blob.size
      touchEntry(cacheKey, currentEntry)
      pruneAttachmentObjectUrls()
      return url
    })
    .catch((error) => {
      const currentEntry = attachmentObjectUrlCache.get(cacheKey)
      if (currentEntry?.promise === entry.promise) {
        attachmentObjectUrlCache.delete(cacheKey)
      }
      throw error
    })

  attachmentObjectUrlCache.set(cacheKey, entry)
  return entry.promise
}
