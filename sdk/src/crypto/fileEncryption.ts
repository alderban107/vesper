/**
 * Client-side attachment encryption.
 *
 * The legacy helpers encrypt one complete AES-GCM record and remain available
 * for existing messages. New attachments use independently authenticated,
 * fixed-size v2 frames so transport and decryption memory stay bounded.
 */

export const ATTACHMENT_V2_CHUNK_SIZE = 1_048_576
export const ATTACHMENT_V2_TAG_SIZE = 16

const ATTACHMENT_V2_AAD_PREFIX = new TextEncoder().encode('vesper-attachment-v2\0')
const MAX_UINT32 = 0xffff_ffff
const MAX_CHUNK_COUNT = MAX_UINT32 + 1

export interface EncryptedFile {
  ciphertext: ArrayBuffer
  key: string // base64-encoded AES key
  iv: string // base64-encoded IV
}

export interface AttachmentEncryptionV2 {
  v: 2
  key: string
  nonce_prefix: string
}

export interface EncryptedAttachmentStreamV2 {
  ciphertext: ReadableStream<Uint8Array>
  ciphertextSize: number
  encryption: AttachmentEncryptionV2
}

export interface AttachmentPlaintextRangePlan {
  plaintextStart: number
  plaintextEndExclusive: number
  plaintextLength: number
  firstChunk: number
  lastChunk: number
  ciphertextStart: number
  ciphertextEndExclusive: number
  discardPlaintextPrefix: number
}

class ByteQueue {
  private readonly chunks: Uint8Array[] = []
  private firstOffset = 0
  length = 0

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return
    this.chunks.push(chunk)
    this.length += chunk.byteLength
  }

  read(size: number): Uint8Array {
    if (size > this.length) throw new Error('attachment stream ended early')
    const output = new Uint8Array(size)
    let written = 0

    while (written < size) {
      const first = this.chunks[0]
      if (!first) throw new Error('attachment stream ended early')
      const available = first.byteLength - this.firstOffset
      const take = Math.min(size - written, available)
      output.set(first.subarray(this.firstOffset, this.firstOffset + take), written)
      written += take
      this.firstOffset += take
      this.length -= take

      if (this.firstOffset === first.byteLength) {
        this.chunks.shift()
        this.firstOffset = 0
      }
    }

    return output
  }
}

function arrayBufferToBase64(buffer: ArrayBufferLike): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

function decodeCanonicalBase64(value: string, byteLength: number, label: string): Uint8Array {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`invalid ${label}`)
  }

  let decoded: ArrayBuffer
  try {
    decoded = base64ToArrayBuffer(value)
  } catch {
    throw new Error(`invalid ${label}`)
  }

  if (decoded.byteLength !== byteLength || arrayBufferToBase64(decoded) !== value) {
    throw new Error(`invalid ${label}`)
  }

  return new Uint8Array(decoded)
}

function assertPlaintextSize(plaintextSize: number): number {
  if (!Number.isSafeInteger(plaintextSize) || plaintextSize < 0) {
    throw new Error('invalid attachment plaintext size')
  }

  const count = attachmentChunkCount(plaintextSize)
  if (count > MAX_CHUNK_COUNT) throw new Error('attachment has too many chunks')
  return plaintextSize
}

export function assertAttachmentEncryptionV2(value: unknown): AttachmentEncryptionV2 {
  if (!value || typeof value !== 'object') throw new Error('invalid attachment encryption')
  const candidate = value as Partial<AttachmentEncryptionV2>
  if (candidate.v !== 2) throw new Error('unsupported attachment encryption version')
  decodeCanonicalBase64(candidate.key ?? '', 32, 'attachment key')
  decodeCanonicalBase64(candidate.nonce_prefix ?? '', 8, 'attachment nonce prefix')
  return candidate as AttachmentEncryptionV2
}

export function attachmentChunkCount(plaintextSize: number): number {
  if (!Number.isSafeInteger(plaintextSize) || plaintextSize < 0) {
    throw new Error('invalid attachment plaintext size')
  }
  return Math.max(1, Math.ceil(plaintextSize / ATTACHMENT_V2_CHUNK_SIZE))
}

export function attachmentChunkPlaintextLength(plaintextSize: number, chunkIndex: number): number {
  assertPlaintextSize(plaintextSize)
  const count = attachmentChunkCount(plaintextSize)
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= count) {
    throw new Error('invalid attachment chunk index')
  }
  if (plaintextSize === 0) return 0
  return Math.min(ATTACHMENT_V2_CHUNK_SIZE, plaintextSize - chunkIndex * ATTACHMENT_V2_CHUNK_SIZE)
}

export function attachmentCiphertextSize(plaintextSize: number): number {
  assertPlaintextSize(plaintextSize)
  const size = plaintextSize + attachmentChunkCount(plaintextSize) * ATTACHMENT_V2_TAG_SIZE
  if (!Number.isSafeInteger(size)) throw new Error('attachment ciphertext is too large')
  return size
}

export function attachmentChunkCiphertextOffset(chunkIndex: number): number {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > MAX_UINT32) {
    throw new Error('invalid attachment chunk index')
  }
  return chunkIndex * (ATTACHMENT_V2_CHUNK_SIZE + ATTACHMENT_V2_TAG_SIZE)
}

function attachmentChunkNonce(prefix: Uint8Array, chunkIndex: number): Uint8Array {
  if (prefix.byteLength !== 8 || chunkIndex < 0 || chunkIndex > MAX_UINT32) {
    throw new Error('invalid attachment nonce input')
  }
  const nonce = new Uint8Array(12)
  nonce.set(prefix)
  new DataView(nonce.buffer).setUint32(8, chunkIndex, false)
  return nonce
}

function attachmentChunkAad(
  plaintextSize: number,
  chunkIndex: number,
  chunkPlaintextLength: number
): Uint8Array {
  const aad = new Uint8Array(ATTACHMENT_V2_AAD_PREFIX.byteLength + 20)
  aad.set(ATTACHMENT_V2_AAD_PREFIX)
  const view = new DataView(aad.buffer, ATTACHMENT_V2_AAD_PREFIX.byteLength)
  view.setBigUint64(0, BigInt(plaintextSize), false)
  view.setUint32(8, ATTACHMENT_V2_CHUNK_SIZE, false)
  view.setUint32(12, chunkIndex, false)
  view.setUint32(16, chunkPlaintextLength, false)
  return aad
}

async function importAttachmentKey(rawKey: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    rawKey.buffer as ArrayBuffer,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage]
  )
}

async function fillQueue(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  queue: ByteQueue,
  required: number,
  sourceState: { done: boolean }
): Promise<void> {
  while (queue.length < required && !sourceState.done) {
    const next = await reader.read()
    sourceState.done = next.done
    if (next.value) queue.push(next.value)
  }
}

async function requireExactFinalSize(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  queue: ByteQueue,
  required: number,
  sourceState: { done: boolean }
): Promise<void> {
  await fillQueue(reader, queue, required, sourceState)
  if (queue.length < required) throw new Error('attachment stream ended early')

  while (!sourceState.done) {
    const next = await reader.read()
    sourceState.done = next.done
    if (next.value) queue.push(next.value)
    if (queue.length > required) throw new Error('attachment stream contains trailing bytes')
  }

  if (queue.length !== required) throw new Error('attachment stream contains trailing bytes')
}

export async function encryptAttachmentStreamV2(
  plaintext: ReadableStream<Uint8Array>,
  plaintextSize: number
): Promise<EncryptedAttachmentStreamV2> {
  assertPlaintextSize(plaintextSize)
  const rawKey = crypto.getRandomValues(new Uint8Array(32))
  const noncePrefix = crypto.getRandomValues(new Uint8Array(8))
  const key = await importAttachmentKey(rawKey, 'encrypt')
  const reader = plaintext.getReader()
  const queue = new ByteQueue()
  const sourceState = { done: false }
  const chunkCount = attachmentChunkCount(plaintextSize)
  let chunkIndex = 0

  const ciphertext = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunkLength = attachmentChunkPlaintextLength(plaintextSize, chunkIndex)
        const finalChunk = chunkIndex === chunkCount - 1
        if (finalChunk) {
          await requireExactFinalSize(reader, queue, chunkLength, sourceState)
        } else {
          await fillQueue(reader, queue, chunkLength, sourceState)
          if (queue.length < chunkLength) throw new Error('attachment stream ended early')
        }

        const encrypted = await crypto.subtle.encrypt(
          {
            name: 'AES-GCM',
            iv: attachmentChunkNonce(noncePrefix, chunkIndex).buffer as ArrayBuffer,
            additionalData: attachmentChunkAad(plaintextSize, chunkIndex, chunkLength).buffer as ArrayBuffer,
            tagLength: 128
          },
          key,
          queue.read(chunkLength).buffer as ArrayBuffer
        )

        controller.enqueue(new Uint8Array(encrypted))
        chunkIndex += 1
        if (finalChunk) {
          reader.releaseLock()
          controller.close()
        }
      } catch (error) {
        reader.releaseLock()
        controller.error(error)
      }
    },
    async cancel(reason) {
      await reader.cancel(reason)
      reader.releaseLock()
    }
  })

  return {
    ciphertext,
    ciphertextSize: attachmentCiphertextSize(plaintextSize),
    encryption: {
      v: 2,
      key: arrayBufferToBase64(rawKey.buffer),
      nonce_prefix: arrayBufferToBase64(noncePrefix.buffer)
    }
  }
}

export async function encryptAttachmentBlobV2(blob: Blob): Promise<EncryptedAttachmentStreamV2> {
  return await encryptAttachmentStreamV2(blob.stream(), blob.size)
}

export function decryptAttachmentStreamV2(
  ciphertext: ReadableStream<Uint8Array>,
  encryptionValue: AttachmentEncryptionV2,
  plaintextSize: number,
  firstChunkIndex = 0,
  lastChunkIndex = attachmentChunkCount(plaintextSize) - 1
): ReadableStream<Uint8Array> {
  assertPlaintextSize(plaintextSize)
  const encryption = assertAttachmentEncryptionV2(encryptionValue)
  const rawKey = decodeCanonicalBase64(encryption.key, 32, 'attachment key')
  const noncePrefix = decodeCanonicalBase64(encryption.nonce_prefix, 8, 'attachment nonce prefix')
  const chunkCount = attachmentChunkCount(plaintextSize)
  if (
    !Number.isSafeInteger(firstChunkIndex) ||
    !Number.isSafeInteger(lastChunkIndex) ||
    firstChunkIndex < 0 ||
    lastChunkIndex < firstChunkIndex ||
    lastChunkIndex >= chunkCount
  ) {
    throw new Error('invalid attachment chunk range')
  }

  const reader = ciphertext.getReader()
  const queue = new ByteQueue()
  const sourceState = { done: false }
  let chunkIndex = firstChunkIndex
  let keyPromise: Promise<CryptoKey> | null = null

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const plaintextLength = attachmentChunkPlaintextLength(plaintextSize, chunkIndex)
        const frameLength = plaintextLength + ATTACHMENT_V2_TAG_SIZE
        const finalChunk = chunkIndex === lastChunkIndex
        if (finalChunk) {
          await requireExactFinalSize(reader, queue, frameLength, sourceState)
        } else {
          await fillQueue(reader, queue, frameLength, sourceState)
          if (queue.length < frameLength) throw new Error('attachment stream ended early')
        }

        keyPromise ??= importAttachmentKey(rawKey, 'decrypt')
        const decrypted = await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: attachmentChunkNonce(noncePrefix, chunkIndex).buffer as ArrayBuffer,
            additionalData: attachmentChunkAad(plaintextSize, chunkIndex, plaintextLength).buffer as ArrayBuffer,
            tagLength: 128
          },
          await keyPromise,
          queue.read(frameLength).buffer as ArrayBuffer
        )

        controller.enqueue(new Uint8Array(decrypted))
        chunkIndex += 1
        if (finalChunk) {
          reader.releaseLock()
          controller.close()
        }
      } catch (error) {
        reader.releaseLock()
        controller.error(error)
      }
    },
    async cancel(reason) {
      await reader.cancel(reason)
      reader.releaseLock()
    }
  })
}

export function planAttachmentPlaintextRange(
  plaintextSize: number,
  plaintextStart: number,
  plaintextEndExclusive: number
): AttachmentPlaintextRangePlan {
  assertPlaintextSize(plaintextSize)
  if (
    !Number.isSafeInteger(plaintextStart) ||
    !Number.isSafeInteger(plaintextEndExclusive) ||
    plaintextStart < 0 ||
    plaintextEndExclusive < plaintextStart ||
    plaintextEndExclusive > plaintextSize ||
    (plaintextSize > 0 && plaintextStart === plaintextEndExclusive)
  ) {
    throw new Error('invalid attachment plaintext range')
  }

  const firstChunk = plaintextSize === 0 ? 0 : Math.floor(plaintextStart / ATTACHMENT_V2_CHUNK_SIZE)
  const lastChunk = plaintextSize === 0
    ? 0
    : Math.floor((plaintextEndExclusive - 1) / ATTACHMENT_V2_CHUNK_SIZE)
  const lastFrameLength = attachmentChunkPlaintextLength(plaintextSize, lastChunk) + ATTACHMENT_V2_TAG_SIZE
  const ciphertextStart = attachmentChunkCiphertextOffset(firstChunk)
  const ciphertextEndExclusive = attachmentChunkCiphertextOffset(lastChunk) + lastFrameLength

  return {
    plaintextStart,
    plaintextEndExclusive,
    plaintextLength: plaintextEndExclusive - plaintextStart,
    firstChunk,
    lastChunk,
    ciphertextStart,
    ciphertextEndExclusive,
    discardPlaintextPrefix: plaintextStart - firstChunk * ATTACHMENT_V2_CHUNK_SIZE
  }
}

export async function encryptFile(data: ArrayBuffer): Promise<EncryptedFile> {
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  )

  const iv = crypto.getRandomValues(new Uint8Array(12))

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  )

  const exportedKey = await crypto.subtle.exportKey('raw', key)

  return {
    ciphertext,
    key: arrayBufferToBase64(exportedKey),
    iv: arrayBufferToBase64(iv.buffer)
  }
}

export async function decryptFile(
  ciphertext: ArrayBuffer,
  keyBase64: string,
  ivBase64: string
): Promise<ArrayBuffer> {
  const keyData = base64ToArrayBuffer(keyBase64)
  const iv = base64ToArrayBuffer(ivBase64)

  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  )

  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv) },
    key,
    ciphertext
  )
}
