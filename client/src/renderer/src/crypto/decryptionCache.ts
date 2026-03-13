/**
 * In-memory LRU cache for decrypted message content.
 * Prevents re-decryption of messages that have already been displayed.
 * Foundation for future lazy-decrypt-on-scroll pattern.
 */

const DEFAULT_MAX_SIZE = 500

class LRUCache<K, V> {
  private cache = new Map<K, V>()
  private maxSize: number

  constructor(maxSize: number = DEFAULT_MAX_SIZE) {
    this.maxSize = maxSize
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key)
    if (value !== undefined) {
      // Move to end (most recent)
      this.cache.delete(key)
      this.cache.set(key, value)
    }
    return value
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key)
    } else if (this.cache.size >= this.maxSize) {
      // Delete oldest (first entry)
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) this.cache.delete(firstKey)
    }
    this.cache.set(key, value)
  }

  delete(key: K): boolean {
    return this.cache.delete(key)
  }

  clear(): void {
    this.cache.clear()
  }

  get size(): number {
    return this.cache.size
  }
}

// Global decryption cache keyed by message ID
const decryptionCache = new LRUCache<string, string>(2000)

export function getCachedDecryption(messageId: string): string | undefined {
  return decryptionCache.get(messageId)
}

export function setCachedDecryption(messageId: string, plaintext: string): void {
  decryptionCache.set(messageId, plaintext)
}

export function removeCachedDecryption(messageId: string): void {
  decryptionCache.delete(messageId)
}

export function clearDecryptionCache(): void {
  decryptionCache.clear()
}
