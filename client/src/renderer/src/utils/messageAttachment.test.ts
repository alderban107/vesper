import { beforeEach, describe, expect, it, vi } from 'vitest'

const { encryptFile, uploadAttachment } = vi.hoisted(() => ({
  encryptFile: vi.fn(),
  uploadAttachment: vi.fn()
}))

vi.mock('@vesper/sdk/crypto', () => ({ encryptFile }))
vi.mock('../sdk/client', () => ({
  getRendererClient: () => ({ uploadAttachment })
}))

import {
  AttachmentPreparationError,
  prepareMessageAttachment
} from './messageAttachment'

function createFile(): File {
  return {
    name: 'report.txt',
    type: 'text/plain',
    size: 7,
    arrayBuffer: async () => new TextEncoder().encode('payload').buffer
  } as File
}

describe('prepareMessageAttachment', () => {
  beforeEach(() => {
    encryptFile.mockReset()
    uploadAttachment.mockReset()
    encryptFile.mockResolvedValue({
      ciphertext: new Uint8Array([1, 2, 3]),
      iv: 'iv',
      key: 'key'
    })
  })

  it('returns the encrypted upload reference needed for the durable send', async () => {
    uploadAttachment.mockResolvedValue({ attachment: { id: 'attachment-1' } })

    await expect(prepareMessageAttachment(createFile())).resolves.toEqual({
      attachmentIds: ['attachment-1'],
      file: {
        id: 'attachment-1',
        name: 'report.txt',
        content_type: 'text/plain',
        size: 7,
        key: 'key',
        iv: 'iv'
      }
    })
  })

  it('makes an upload failure actionable without discarding the staged file', async () => {
    uploadAttachment.mockRejectedValue(new Error('network unavailable'))

    await expect(prepareMessageAttachment(createFile())).rejects.toMatchObject({
      name: 'AttachmentPreparationError',
      message: 'This file could not be uploaded. Check your connection and try again.',
      hasOrphanedUpload: false
    } satisfies Partial<AttachmentPreparationError>)
  })
})
