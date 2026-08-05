import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAnonymousFilename, resolveStagedFilename } from './attachmentFilename'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('attachment filenames', () => {
  it('creates an opaque name while preserving the final extension', () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-1234-1234-1234-123456789abc')

    expect(createAnonymousFilename('family.photo.jpg')).toBe('1234567812341234.jpg')
  })

  it('reuses the staged anonymous name for preview and send resolution', () => {
    const entry = {
      file: { name: 'private.txt' },
      anonymous: true,
      anonymousName: 'stable-name.txt',
      spoiler: true
    }

    expect(resolveStagedFilename(entry)).toBe('SPOILER_stable-name.txt')
    expect(resolveStagedFilename(entry)).toBe('SPOILER_stable-name.txt')
  })
})
