import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  encryptAttachmentStreamV2,
  type FileAttachment
} from '@vesper/sdk/crypto'

const { fetchAttachmentBytes, fetchAttachmentResponse } = vi.hoisted(() => ({
  fetchAttachmentBytes: vi.fn(),
  fetchAttachmentResponse: vi.fn()
}))

vi.mock('./attachmentFetch', () => ({ fetchAttachmentBytes, fetchAttachmentResponse }))

import {
  abortActiveAttachmentTransfers,
  loadDecryptedAttachmentBlob,
  saveDecryptedAttachment
} from './attachmentTransfer'

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
  fetchAttachmentBytes.mockReset()
  fetchAttachmentResponse.mockReset()
})

describe('attachment transfer', () => {
  it('decrypts a large v2 attachment directly into the selected file stream', async () => {
    const plaintext = new Uint8Array(8 * 1024 * 1024 + 37)
    for (let index = 0; index < plaintext.length; index += 1) plaintext[index] = index % 251
    const encrypted = await encryptAttachmentStreamV2(new Blob([plaintext]).stream(), plaintext.length)
    const ciphertext = await collect(encrypted.ciphertext)
    fetchAttachmentResponse.mockResolvedValue(new Response(ciphertext, {
      status: 200,
      headers: { 'content-length': ciphertext.byteLength.toString() }
    }))

    const written: Uint8Array[] = []
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        written.push(chunk.slice())
      }
    })
    const showSaveFilePicker = vi.fn().mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue(writable)
    })
    vi.stubGlobal('window', { showSaveFilePicker, setTimeout })
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL')

    const attachment: FileAttachment = {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'large.zip',
      content_type: 'application/zip',
      size: plaintext.byteLength,
      encryption: encrypted.encryption
    }

    await saveDecryptedAttachment(attachment, attachment.content_type)

    expect(showSaveFilePicker).toHaveBeenCalledWith(expect.objectContaining({
      suggestedName: 'large.zip'
    }))
    expect(createObjectUrl).not.toHaveBeenCalled()
    const output = await collect(new Blob(written).stream())
    expect(output.byteLength).toBe(plaintext.byteLength)
    expect(Buffer.from(output).equals(Buffer.from(plaintext))).toBe(true)
  })

  it('cancels active plaintext transfers during session reset', async () => {
    fetchAttachmentResponse.mockImplementation(
      (_attachmentId: string, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
        })
    )
    const attachment: FileAttachment = {
      id: '00000000-0000-4000-8000-000000000003',
      name: 'logout.bin',
      content_type: 'application/octet-stream',
      size: 1,
      encryption: {
        v: 2,
        key: Buffer.alloc(32, 1).toString('base64'),
        nonce_prefix: Buffer.alloc(8, 2).toString('base64')
      }
    }

    const transfer = loadDecryptedAttachmentBlob(attachment, attachment.content_type)
    abortActiveAttachmentTransfers()

    await expect(transfer).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('refuses to buffer a large legacy attachment', async () => {
    vi.stubGlobal('window', { setTimeout })
    const attachment: FileAttachment = {
      id: '00000000-0000-4000-8000-000000000002',
      name: 'legacy-video.mp4',
      content_type: 'video/mp4',
      size: 9 * 1024 * 1024,
      key: 'legacy-key',
      iv: 'legacy-iv'
    }

    await expect(saveDecryptedAttachment(attachment, attachment.content_type)).rejects.toThrow(
      'cannot be streamed'
    )
    expect(fetchAttachmentBytes).not.toHaveBeenCalled()
  })
})
