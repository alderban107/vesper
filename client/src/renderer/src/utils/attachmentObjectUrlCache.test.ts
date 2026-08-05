import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  acquireCachedAttachmentObjectUrl,
  clearAttachmentObjectUrlCache,
  loadCachedAttachmentObjectUrl,
  releaseCachedAttachmentObjectUrl
} from './attachmentObjectUrlCache'

beforeEach(() => {
  clearAttachmentObjectUrlCache()
})

afterEach(() => {
  clearAttachmentObjectUrlCache()
  vi.restoreAllMocks()
})

describe('attachment object URL cache', () => {
  it('revokes decrypted object URLs and removes them during session reset', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:decrypted-attachment')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const url = await loadCachedAttachmentObjectUrl(
      'attachment-preview:one',
      async () => new Blob(['decrypted'])
    )
    expect(url).toBe('blob:decrypted-attachment')

    releaseCachedAttachmentObjectUrl('attachment-preview:one')
    clearAttachmentObjectUrlCache()

    expect(revoke).toHaveBeenCalledWith('blob:decrypted-attachment')
    expect(acquireCachedAttachmentObjectUrl('attachment-preview:one')).toBeNull()
  })

  it('evicts unpinned decrypted blobs when their byte budget is exceeded', async () => {
    vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:first')
      .mockReturnValueOnce('blob:second')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const largeBlob = (): Blob => new Blob([new Uint8Array(40 * 1024 * 1024)])

    await loadCachedAttachmentObjectUrl('attachment-preview:first', async () => largeBlob())
    releaseCachedAttachmentObjectUrl('attachment-preview:first')
    await loadCachedAttachmentObjectUrl('attachment-preview:second', async () => largeBlob())

    expect(revoke).toHaveBeenCalledWith('blob:first')
    expect(acquireCachedAttachmentObjectUrl('attachment-preview:first')).toBeNull()
    expect(acquireCachedAttachmentObjectUrl('attachment-preview:second')).toBe('blob:second')
  })
})
