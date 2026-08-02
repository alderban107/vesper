import { describe, expect, it } from 'vitest'

import { classifyRefreshHttpFailure } from './authSession'

describe('desktop refresh response classification', () => {
  it('treats only the server invalid-token response as terminal', () => {
    expect(classifyRefreshHttpFailure(401)).toBe('invalid')
  })

  it.each([400, 403, 408, 409, 422, 429, 500, 502, 503, 504])(
    'preserves the refresh token for non-definitive status %s',
    (status) => {
      expect(classifyRefreshHttpFailure(status)).toBe('retryable')
    }
  )
})
