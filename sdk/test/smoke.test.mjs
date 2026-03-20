import assert from 'node:assert/strict'
import test from 'node:test'

import { getCurrentUser } from '../dist/api/index.js'
import { bootServerStack, teardownServerStack } from '../dist/testing/index.js'
import {
  createVesperTransport
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

function createSdkTransport(apiUrl) {
  return createVesperTransport({
    baseUrl: apiUrl,
    fetchImpl: fetch,
    socketOptions: {
      logger: {
        error: () => {},
        log: () => {}
      }
    }
  })
}

async function registerUser(httpClient, sessionStore, username, password, label) {
  const registerResponse = await httpClient.apiFetch('/api/v1/auth/register', {
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
    await teardownServerStack(stack)
  }
}

test('sdk auth and realtime smoke works against a live Vesper server', { concurrency: false }, async () => {
  await withServerStack(async (stack) => {
    const transport = createSdkTransport(stack.apiUrl)
    const username = `sdk_smoke_${Date.now()}`
    const password = 'vesper-sdk-smoke-password'

    await registerUser(transport.httpClient, transport.sessionStore, username, password, 'SDK Smoke')

    const currentUser = await getCurrentUser(transport.httpClient)
    assert.equal(currentUser.username, username)

    const events = []
    transport.socketClient.connect()

    await transport.socketClient.joinChannelWithAck(`user:${currentUser.id}`, (event, payload) => {
      events.push({ event, payload })
    })

    transport.socketClient.pushToChannel(`user:${currentUser.id}`, 'heartbeat', {})
    assert.ok(transport.socketClient.getChannel(`user:${currentUser.id}`))
    transport.socketClient.disconnect()
    assert.ok(Array.isArray(events))
  })
})

test('sdk refreshes an expired access token and retries the request', { concurrency: false }, async () => {
  await withServerStack(async (stack) => {
    const transport = createSdkTransport(stack.apiUrl)
    const username = `sdk_refresh_${Date.now()}`
    const password = 'vesper-sdk-refresh-password'

    await registerUser(transport.httpClient, transport.sessionStore, username, password, 'SDK Refresh')

    const originalRefreshToken = transport.sessionStore.getRefreshToken()
    assert.ok(originalRefreshToken)

    transport.sessionStore.setTokens('expired-access-token', originalRefreshToken)

    const currentUser = await getCurrentUser(transport.httpClient)
    assert.equal(currentUser.username, username)
    assert.notEqual(transport.sessionStore.getAccessToken(), 'expired-access-token')
    assert.ok(transport.sessionStore.getAccessToken())
    assert.equal(transport.sessionStore.getSessionNotice(), null)
  })
})

test('sdk clears tokens and sets a session notice when refresh fails', { concurrency: false }, async () => {
  await withServerStack(async (stack) => {
    const transport = createSdkTransport(stack.apiUrl)
    const username = `sdk_notice_${Date.now()}`
    const password = 'vesper-sdk-notice-password'

    await registerUser(transport.httpClient, transport.sessionStore, username, password, 'SDK Notice')
    transport.sessionStore.setTokens('expired-access-token', 'broken-refresh-token')

    const meResponse = await transport.httpClient.apiFetch('/api/v1/auth/me')
    assert.equal(meResponse.status, 401)
    assert.equal(transport.sessionStore.getAccessToken(), null)
    assert.equal(transport.sessionStore.getRefreshToken(), null)

    const notice = transport.sessionStore.getSessionNotice()
    assert.ok(notice)
    assert.equal(notice.title, 'Sign in again on this device')
    assert.match(notice.message, /session can no longer be renewed/i)
  })
})

test('transport creation requires an explicit server URL outside the browser', { concurrency: false }, () => {
  assert.throws(
    () => createVesperTransport({}),
    /baseUrl/i
  )
})
