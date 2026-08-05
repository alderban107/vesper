import {
  encryptAttachmentBlobV2,
  type AttachmentEncryptionV2
} from '@vesper/sdk/crypto'

const MEMORY_STAGING_LIMIT = 8 * 1024 * 1024
const STAGING_DIRECTORY = 'vesper-encrypted-attachment-staging'

export interface StagedEncryptedAttachment {
  ciphertext: Blob
  ciphertextSize: number
  encryption: AttachmentEncryptionV2
  cleanup: () => Promise<void>
}

async function collectCiphertextInMemory(
  stream: ReadableStream<Uint8Array>,
  expectedSize: number
): Promise<Blob> {
  const chunks: Uint8Array[] = []
  let received = 0
  const reader = stream.getReader()

  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(next.value)
      received += next.value.byteLength
    }
  } finally {
    reader.releaseLock()
  }

  if (received !== expectedSize) throw new Error('encrypted attachment staging size mismatch')
  return new Blob(chunks, { type: 'application/octet-stream' })
}

async function stageInOriginPrivateFileSystem(
  stream: ReadableStream<Uint8Array>,
  expectedSize: number
): Promise<{ blob: Blob; cleanup: () => Promise<void> } | null> {
  if (!navigator.storage?.getDirectory) return null

  const root = await navigator.storage.getDirectory()
  const directory = await root.getDirectoryHandle(STAGING_DIRECTORY, { create: true })
  const entryName = `${crypto.randomUUID()}.ciphertext`
  const handle = await directory.getFileHandle(entryName, { create: true })

  try {
    const writable = await handle.createWritable()
    await stream.pipeTo(writable)
    const blob = await handle.getFile()
    if (blob.size !== expectedSize) throw new Error('encrypted attachment staging size mismatch')

    return {
      blob,
      cleanup: async () => {
        try {
          await directory.removeEntry(entryName)
        } catch {
          // Already removed by session cleanup or a concurrent retry.
        }
      }
    }
  } catch (error) {
    try {
      await directory.removeEntry(entryName)
    } catch {
      // Preserve the original encryption or filesystem failure.
    }
    throw error
  }
}

export async function stageEncryptedAttachment(source: Blob): Promise<StagedEncryptedAttachment> {
  let encrypted = await encryptAttachmentBlobV2(source)
  let staged: Awaited<ReturnType<typeof stageInOriginPrivateFileSystem>> = null

  try {
    staged = await stageInOriginPrivateFileSystem(encrypted.ciphertext, encrypted.ciphertextSize)
  } catch (error) {
    if (encrypted.ciphertextSize > MEMORY_STAGING_LIMIT) throw error
    try {
      await encrypted.ciphertext.cancel('origin-private staging failed')
    } catch {
      // pipeTo may already have consumed and closed the stream.
    }
    // The OPFS stream is one-shot. Re-encrypt small files for the bounded
    // in-memory fallback rather than retaining the complete plaintext.
    encrypted = await encryptAttachmentBlobV2(source)
  }

  if (staged) {
    return {
      ciphertext: staged.blob,
      ciphertextSize: encrypted.ciphertextSize,
      encryption: encrypted.encryption,
      cleanup: staged.cleanup
    }
  }

  if (encrypted.ciphertextSize > MEMORY_STAGING_LIMIT) {
    await encrypted.ciphertext.cancel('bounded-memory attachment staging is unavailable')
    throw new Error('Large encrypted uploads require origin-private file storage in this browser.')
  }

  return {
    ciphertext: await collectCiphertextInMemory(encrypted.ciphertext, encrypted.ciphertextSize),
    ciphertextSize: encrypted.ciphertextSize,
    encryption: encrypted.encryption,
    cleanup: async () => {}
  }
}

export async function clearEncryptedAttachmentStaging(): Promise<void> {
  if (!navigator.storage?.getDirectory) return
  const root = await navigator.storage.getDirectory()
  try {
    await root.removeEntry(STAGING_DIRECTORY, { recursive: true })
  } catch {
    // The directory is absent or another tab already removed it.
  }
}
