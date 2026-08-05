import { afterEach, describe, expect, it, vi } from 'vitest'
import { decryptAttachmentStreamV2 } from '@vesper/sdk/crypto'
import { stageEncryptedAttachment } from './attachmentEncryptionStaging'

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of stream) {
    chunks.push(chunk)
    length += chunk.byteLength
  }
  const output = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('encrypted attachment staging', () => {
  it('writes only ciphertext to OPFS without reading the complete plaintext buffer', async () => {
    const plaintext = new TextEncoder().encode('streamed attachment staging')
    const source = new Blob([plaintext])
    const arrayBuffer = vi.spyOn(source, 'arrayBuffer').mockRejectedValue(new Error('must not buffer'))
    const written: Uint8Array[] = []
    const removeEntry = vi.fn().mockResolvedValue(undefined)
    const fileHandle = {
      createWritable: vi.fn().mockResolvedValue(new WritableStream<Uint8Array>({
        write(chunk) {
          written.push(chunk.slice())
        }
      })),
      getFile: vi.fn().mockImplementation(async () => new Blob(written))
    }
    const directory = {
      getFileHandle: vi.fn().mockResolvedValue(fileHandle),
      removeEntry
    }
    const root = {
      getDirectoryHandle: vi.fn().mockResolvedValue(directory),
      removeEntry: vi.fn()
    }
    vi.stubGlobal('navigator', {
      storage: { getDirectory: vi.fn().mockResolvedValue(root) }
    })

    const staged = await stageEncryptedAttachment(source)
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(staged.ciphertext.size).toBe(staged.ciphertextSize)
    expect(staged.ciphertext.size).toBeGreaterThan(source.size)

    const decrypted = await collect(
      decryptAttachmentStreamV2(staged.ciphertext.stream(), staged.encryption, source.size)
    )
    expect(Buffer.from(decrypted).equals(Buffer.from(plaintext))).toBe(true)

    await staged.cleanup()
    expect(removeEntry).toHaveBeenCalledTimes(1)
  })

  it('falls back to bounded memory for small files when OPFS is unavailable', async () => {
    vi.stubGlobal('navigator', {
      storage: { getDirectory: vi.fn().mockRejectedValue(new Error('OPFS denied')) }
    })
    const source = new Blob(['small attachment'])

    const staged = await stageEncryptedAttachment(source)
    expect(staged.ciphertext.size).toBe(staged.ciphertextSize)
    await expect(staged.cleanup()).resolves.toBeUndefined()
  })
})
