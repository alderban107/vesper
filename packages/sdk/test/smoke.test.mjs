import assert from 'node:assert/strict'
import test from 'node:test'

import { bootServerStack, teardownServerStack } from '../dist/testing/index.js'
import {
  VesperSocketClient,
  apiFetch,
  configureHttpClient,
  createMemorySessionStore
} from '../dist/transport/index.js'

function createRegisterPayload(username, password, label = 'SDK Smoke') {
  return {
    username,
    password,
    device_id: `sdk-device-${Math.random().toString(36).slice(2, 12)}`,
    device_name: label,
    device_platform: 'node'
  }
}

function configureSdk(apiUrl) {
  const sessionStore = createMemorySessionStore(apiUrl)
  configureHttpClient({
    fetchImpl: fetch,
    sessionStore
  })
  return sessionStore
}

async function registerUser(sessionStore, username, password, label) {
  const registerResponse = await apiFetch('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify(createRegisterPayload(username, password, label))
  })

  assert.equal(registerResponse.status, 201)
  const registerBody = await registerResponse.json()
  assert.equal(registerBody.user.username, username)
  assert.ok(registerBody.access_token)
  assert.ok(registerBody.refresh_token)

  sessionStore.setTokens(registerBody.access_token, registerBody.refresh_token)
  return registerBody
}

async function withServerStack(run) {
  const stack = await bootServerStack()

  try {
    await run(stack)
  } finally {
    teardownServerStack(stack)
  }
}

test('sdk auth and realtime smoke works against a live Vesper server', { concurrency: false }, async () => {
  await withServerStack(async (stack) => {
    const sessionStore = configureSdk(stack.apiUrl)
    const username = `sdk_smoke_${Date.now()}`
    const password = 'vesper-sdk-smoke-password'

    await registerUser(sessionStore, username, password, 'SDK Smoke')

    const meResponse = await apiFetch('/api/v1/auth/me')
    assert.equal(meResponse.status, 200)
    const meBody = await meResponse.json()
    assert.equal(meBody.user.username, username)

    const socketClient = new VesperSocketClient({
      getAccessToken: () => sessionStore.getAccessToken(),
      getServerUrl: () => sessionStore.getServerUrl()
    })

    const events = []
    socketClient.connect()

    await socketClient.joinChannelWithAck(`user:${meBody.user.id}`, (event, payload) => {
      events.push({ event, payload })
    })

    socketClient.pushToChannel(`user:${meBody.user.id}`, 'heartbeat', {})
    assert.ok(socketClient.getChannel(`user:${meBody.user.id}`))
    socketClient.disconnect()
    assert.ok(Array.isArray(events))
  })
})

test('sdk refreshes an expired access token and retries the request', { concurrency: false }, async () => {
  await withServerStack(async (stack) => {
    const sessionStore = configureSdk(stack.apiUrl)
    const username = `sdk_refresh_${Date.now()}`
    const password = 'vesper-sdk-refresh-password'

    await registerUser(sessionStore, username, password, 'SDK Refresh')

    const originalRefreshToken = sessionStore.getRefreshToken()
    assert.ok(originalRefreshToken)

    sessionStore.setTokens('expired-access-token', originalRefreshToken)

    const meResponse = await apiFetch('/api/v1/auth/me')
    assert.equal(meResponse.status, 200)

    const meBody = await meResponse.json()
    assert.equal(meBody.user.username, username)
    assert.notEqual(sessionStore.getAccessToken(), 'expired-access-token')
    assert.ok(sessionStore.getAccessToken())
    assert.equal(sessionStore.getSessionNotice(), null)
  })
})

test('sdk clears tokens and sets a session notice when refresh fails', { concurrency: false }, async () => {
  await withServerStack(async (stack) => {
    const sessionStore = configureSdk(stack.apiUrl)
    const username = `sdk_notice_${Date.now()}`
    const password = 'vesper-sdk-notice-password'

    await registerUser(sessionStore, username, password, 'SDK Notice')
    sessionStore.setTokens('expired-access-token', 'broken-refresh-token')

    const meResponse = await apiFetch('/api/v1/auth/me')
    assert.equal(meResponse.status, 401)
    assert.equal(sessionStore.getAccessToken(), null)
    assert.equal(sessionStore.getRefreshToken(), null)

    const notice = sessionStore.getSessionNotice()
    assert.ok(notice)
    assert.equal(notice.title, 'Sign in again on this device')
    assert.match(notice.message, /session can no longer be renewed/i)
  })
})

test('memory session stores require an explicit server URL', { concurrency: false }, () => {
  assert.throws(
    () => createMemorySessionStore(''),
    /explicit server URL/i
  )
})
