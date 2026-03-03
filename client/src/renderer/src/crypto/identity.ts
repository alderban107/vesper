import { argon2id } from 'hash-wasm'
import type { EncryptedKeyBundle, RecoveryKeyData } from './types'

// BIP39 english wordlist (2048 words) — subset used for 256-bit recovery keys
// We use a simplified approach: 24 words from a curated list of 256 unambiguous words
// This gives 24 * 8 = 192 bits of entropy per word selection from 256 options,
// but we actually encode 256 bits by using 2048-word list indices
const WORDLIST_URL = 'https://raw.githubusercontent.com/bitcoin/bips/master/bip-0039/english.txt'
let cachedWordlist: string[] | null = null

async function getWordlist(): Promise<string[]> {
  if (cachedWordlist) return cachedWordlist
  // Embedded minimal wordlist — 256 carefully chosen words for recovery keys
  // Each word encodes ~11 bits (2048 possible words). 24 words = 264 bits (with checksum)
  // For our purposes we use 24 words to encode 256 bits of key material
  cachedWordlist = generateWordlist()
  return cachedWordlist
}

function generateWordlist(): string[] {
  // BIP39-compatible: 2048 common English words
  // Rather than bundling the full list, we'll generate indices
  // and use a deterministic approach
  // For production, we embed the actual BIP39 wordlist
  // For now, we use a simpler scheme: convert bytes to hex-based words
  const words: string[] = []
  const consonants = 'bcdfghjklmnpqrstvwxyz'
  const vowels = 'aeiou'
  // Generate 2048 pronounceable words deterministically
  for (let i = 0; i < 2048; i++) {
    const c1 = consonants[i % consonants.length]
    const v1 = vowels[Math.floor(i / consonants.length) % vowels.length]
    const c2 = consonants[Math.floor(i / (consonants.length * vowels.length)) % consonants.length]
    const v2 = vowels[Math.floor(i / (consonants.length * vowels.length * consonants.length)) % vowels.length]
    const c3 = consonants[Math.floor(i / (consonants.length * vowels.length * consonants.length * vowels.length)) % consonants.length]
    words.push(c1 + v1 + c2 + v2 + c3)
  }
  return words
}

/**
 * Derive a 256-bit encryption key from a password using Argon2id.
 * Parameters: t=3 iterations, m=65536 KiB (64MB), p=4 parallelism
 */
export async function derivePasswordKey(
  password: string,
  salt: Uint8Array
): Promise<CryptoKey> {
  const hash = await argon2id({
    password,
    salt,
    parallelism: 4,
    iterations: 3,
    memorySize: 65536,
    hashLength: 32,
    outputType: 'binary'
  })

  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt'
  ])
}

/**
 * Encrypt a key bundle with AES-256-GCM using a password-derived key.
 */
export async function encryptKeyBundle(
  privateKeys: Uint8Array,
  passwordKey: CryptoKey
): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    passwordKey,
    privateKeys
  )
  return { ciphertext: new Uint8Array(ciphertext), nonce }
}

/**
 * Decrypt a key bundle with AES-256-GCM using a password-derived key.
 */
export async function decryptKeyBundle(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  passwordKey: CryptoKey
): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce },
    passwordKey,
    ciphertext
  )
  return new Uint8Array(plaintext)
}

/**
 * Encrypt private keys for server-side backup (password-based).
 * Returns the full encrypted bundle ready for server storage.
 */
export async function createEncryptedKeyBundle(
  privateKeys: Uint8Array,
  password: string
): Promise<EncryptedKeyBundle> {
  const salt = crypto.getRandomValues(new Uint8Array(32))
  const passwordKey = await derivePasswordKey(password, salt)
  const { ciphertext, nonce } = await encryptKeyBundle(privateKeys, passwordKey)
  return { ciphertext, nonce, salt }
}

/**
 * Decrypt private keys from server-side backup.
 */
export async function decryptEncryptedKeyBundle(
  bundle: EncryptedKeyBundle,
  password: string
): Promise<Uint8Array> {
  const passwordKey = await derivePasswordKey(password, bundle.salt)
  return decryptKeyBundle(bundle.ciphertext, bundle.nonce, passwordKey)
}

/**
 * Generate a 256-bit recovery key and encode as a 24-word mnemonic.
 */
export async function generateRecoveryKey(): Promise<{
  mnemonic: string
  keyBytes: Uint8Array
}> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32))
  const wordlist = await getWordlist()
  const words: string[] = []

  // Convert 32 bytes (256 bits) to 24 words from 2048-word list
  // Each word encodes ~10.67 bits. We use 11-bit indices (BIP39 style)
  // 24 words * 11 bits = 264 bits — last 8 bits are checksum
  const hashBuffer = await crypto.subtle.digest('SHA-256', keyBytes)
  const checksum = new Uint8Array(hashBuffer)[0]

  // Combine key bytes + checksum byte for 33 bytes = 264 bits
  const allBits = new Uint8Array(33)
  allBits.set(keyBytes)
  allBits[32] = checksum

  // Extract 24 11-bit indices
  for (let i = 0; i < 24; i++) {
    const bitOffset = i * 11
    const byteIndex = Math.floor(bitOffset / 8)
    const bitIndex = bitOffset % 8

    let index = (allBits[byteIndex] << 8) | (allBits[byteIndex + 1] || 0)
    if (byteIndex + 2 < allBits.length) {
      index = (index << 8) | allBits[byteIndex + 2]
      index = (index >> (24 - bitIndex - 11)) & 0x7ff
    } else {
      index = (index >> (16 - bitIndex - 11)) & 0x7ff
    }

    words.push(wordlist[index])
  }

  return { mnemonic: words.join(' '), keyBytes }
}

/**
 * Convert a 24-word mnemonic back to the raw 256-bit key.
 */
export async function recoveryKeyToBytes(mnemonic: string): Promise<Uint8Array> {
  const wordlist = await getWordlist()
  const words = mnemonic.trim().split(/\s+/)
  if (words.length !== 24) {
    throw new Error('Recovery key must be exactly 24 words')
  }

  // Convert words back to 11-bit indices
  const indices = words.map((word) => {
    const idx = wordlist.indexOf(word.toLowerCase())
    if (idx === -1) throw new Error(`Unknown recovery key word: ${word}`)
    return idx
  })

  // Reconstruct 264 bits (33 bytes) from 24 11-bit indices
  const allBits = new Uint8Array(33)
  for (let i = 0; i < 24; i++) {
    const bitOffset = i * 11
    const byteIndex = Math.floor(bitOffset / 8)
    const bitIndex = bitOffset % 8

    // Set the 11-bit value at the correct position
    const value = indices[i]
    if (bitIndex <= 5) {
      allBits[byteIndex] |= value >> (3 + bitIndex)
      allBits[byteIndex + 1] |= (value << (5 - bitIndex)) & 0xff
    } else {
      allBits[byteIndex] |= value >> (3 + bitIndex)
      allBits[byteIndex + 1] |= (value >> (bitIndex - 5)) & 0xff
      if (byteIndex + 2 < allBits.length) {
        allBits[byteIndex + 2] |= (value << (13 - bitIndex)) & 0xff
      }
    }
  }

  // Extract 32-byte key and verify checksum
  const keyBytes = allBits.slice(0, 32)
  const checksum = allBits[32]
  const hashBuffer = await crypto.subtle.digest('SHA-256', keyBytes)
  const expectedChecksum = new Uint8Array(hashBuffer)[0]

  if (checksum !== expectedChecksum) {
    throw new Error('Invalid recovery key (checksum mismatch)')
  }

  return keyBytes
}

/**
 * Create a recovery key and encrypt the private keys with it.
 * Returns the mnemonic (shown to user), hash (stored on server), and encrypted bundle.
 */
export async function createRecoveryData(
  privateKeys: Uint8Array
): Promise<RecoveryKeyData> {
  const { mnemonic, keyBytes } = await generateRecoveryKey()

  // Use recovery key bytes as AES key directly
  const recoveryAesKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  )

  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    recoveryAesKey,
    privateKeys
  )

  // Hash the recovery key for server-side verification
  const hashBuffer = await crypto.subtle.digest('SHA-256', keyBytes)
  const hashArray = new Uint8Array(hashBuffer)
  const hash = Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  // Combine nonce + ciphertext for storage
  const encryptedBundle = new Uint8Array(nonce.length + encrypted.byteLength)
  encryptedBundle.set(nonce)
  encryptedBundle.set(new Uint8Array(encrypted), nonce.length)

  return { mnemonic, hash, encryptedBundle, bundleNonce: nonce }
}

/**
 * Decrypt private keys using a recovery mnemonic.
 */
export async function decryptWithRecoveryKey(
  mnemonic: string,
  encryptedBundle: Uint8Array
): Promise<Uint8Array> {
  const keyBytes = await recoveryKeyToBytes(mnemonic)

  const recoveryAesKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  )

  // Extract nonce (first 12 bytes) and ciphertext
  const nonce = encryptedBundle.slice(0, 12)
  const ciphertext = encryptedBundle.slice(12)

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce },
    recoveryAesKey,
    ciphertext
  )

  return new Uint8Array(plaintext)
}

/**
 * Generate a random salt for Argon2id.
 */
export function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}
