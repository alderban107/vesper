import assert from 'node:assert/strict'
import { test } from 'node:test'

import { VesperHttpClient } from '../dist/api/client.js'

function delegatedStore(refreshAccessToken, state = {}) {
  state.notice = null
  state.clearCalls = 0
  return {
    getServerUrl: () => 'https://vesper.example',
    getAccessToken: () => null,
    getRefreshToken: () => null,
    refreshAccessToken,
    setTokens: () => {},
    clearTokens: () => {
      state.clearCalls += 1
    },
    setSessionNotice: (value) => {
      state.notice = value
    },
    clearSessionNotice: () => {
      state.notice = null
    },
    getSessionNotice: () => state.notice,
    emitSessionNotice: () => {}
  }
}

test('delegated refresh restores a desktop session without exposing a refresh token', async () => {
  let refreshCalls = 0
  const requests = []
  const client = new VesperHttpClient({
    sessionStore: delegatedStore(async () => {
      refreshCalls += 1
      return { status: 'ok', accessToken: 'delegated-access-token' }
    }),
    fetchImpl: async (_url, options) => {
      requests.push({ ...options, headers: { ...options.headers } })
      return new Response(null, { status: requests.length === 1 ? 401 : 200 })
    }
  })

  const response = await client.apiFetch('/api/v1/users/me')

  assert.equal(response.status, 200)
  assert.equal(refreshCalls, 1)
  assert.equal(requests[0].headers.Authorization, undefined)
  assert.equal(requests[1].headers.Authorization, 'Bearer delegated-access-token')
})

test('delegated refresh is not attempted for failed public authentication', async () => {
  let refreshCalls = 0
  const client = new VesperHttpClient({
    sessionStore: delegatedStore(async () => {
      refreshCalls += 1
      return { status: 'ok', accessToken: 'stale-session-token' }
    }),
    fetchImpl: async () => new Response(null, { status: 401 })
  })

  const response = await client.apiFetch('/api/v1/auth/login', { method: 'POST' })

  assert.equal(response.status, 401)
  assert.equal(refreshCalls, 0)
})

test('invalid delegated refresh clears the stored session', async () => {
  const state = {}
  const client = new VesperHttpClient({
    sessionStore: delegatedStore(async () => ({ status: 'invalid' }), state),
    fetchImpl: async () => new Response(null, { status: 401 })
  })

  const response = await client.apiFetch('/api/v1/users/me')

  assert.equal(response.status, 401)
  assert.equal(state.clearCalls, 1)
  assert.match(state.notice.message, /sign in again/i)
})

test('retryable delegated refresh failures preserve the stored session', async () => {
  const state = {}
  const client = new VesperHttpClient({
    sessionStore: delegatedStore(async () => ({ status: 'retryable' }), state),
    fetchImpl: async () => new Response(null, { status: 401 })
  })

  const response = await client.apiFetch('/api/v1/users/me')

  assert.equal(response.status, 401)
  assert.equal(state.clearCalls, 0)
  assert.equal(state.notice, null)
})
