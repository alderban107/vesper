import { beforeEach, describe, expect, it, vi } from 'vitest'

const { stageEncryptedAttachment, uploadAttachmentBlob } = vi.hoisted(() => ({
  stageEncryptedAttachment: vi.fn(),
  uploadAttachmentBlob: vi.fn()
}))

vi.mock('./attachmentEncryptionStaging', () => ({ stageEncryptedAttachment }))
vi.mock('../sdk/client', () => ({
  getRendererClient: () => ({ uploadAttachmentBlob })
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
    stageEncryptedAttachment.mockReset()
    uploadAttachmentBlob.mockReset()
    stageEncryptedAttachment.mockResolvedValue({
      ciphertext: new Blob([new Uint8Array([1, 2, 3])]),
      ciphertextSize: 3,
      encryption: { v: 2, key: 'key', nonce_prefix: 'nonce' },
      cleanup: vi.fn().mockResolvedValue(undefined)
    })
  })

  it('returns the streamable encrypted upload reference needed for the durable send', async () => {
    uploadAttachmentBlob.mockResolvedValue({ attachment: { id: 'attachment-1' } })

    await expect(prepareMessageAttachment(createFile())).resolves.toEqual({
      attachmentIds: ['attachment-1'],
      file: {
        id: 'attachment-1',
        name: 'report.txt',
        content_type: 'text/plain',
        size: 7,
        encryption: { v: 2, key: 'key', nonce_prefix: 'nonce' }
      }
    })
  })

  it('makes an upload failure actionable without discarding the staged file', async () => {
    uploadAttachmentBlob.mockRejectedValue(new Error('network unavailable'))

    await expect(prepareMessageAttachment(createFile())).rejects.toMatchObject({
      name: 'AttachmentPreparationError',
      message: 'This file could not be uploaded. Check your connection and try again.',
      hasOrphanedUpload: false
    } satisfies Partial<AttachmentPreparationError>)
  })
})
