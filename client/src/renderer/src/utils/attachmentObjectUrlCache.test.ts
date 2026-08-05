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
})
