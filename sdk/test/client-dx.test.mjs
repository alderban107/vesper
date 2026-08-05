import assert from 'node:assert/strict'
import test from 'node:test'

import { createVesperClient } from '../dist/index.js'
import { verifyHistoryBundlePlaintext } from '../dist/client/messageAuthenticity.js'
import { MemoryStorage } from '../dist/storage/index.js'
import { createMemorySessionStore, VesperSocketClient } from '../dist/transport/index.js'
import { bootServerStack, teardownServerStack } from '../dist/testing/index.js'

function createClientHarness(apiUrl, label, options = {}) {
  const device = options.device ?? {
    id: `sdk-${label}-${Math.random().toString(36).slice(2, 10)}`,
    name: `SDK ${label}`,
    platform: 'node'
  }
  const sessionStore = options.sessionStore ?? createMemorySessionStore(apiUrl)
  const storage = options.storage ?? new MemoryStorage()

  const client = createVesperClient({
    baseUrl: apiUrl,
    fetchImpl: options.fetchImpl,
    sessionStore,
    storage,
    auth: {
      getDeviceIdentity: () => device
    }
  })

  return { client, device, sessionStore, storage }
}

function uniqueUsername(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

async function loadControlIntents(storage, scopeId, operation) {
  const checkpoint = await storage.getScopeCheckpoint(scopeId)
  return checkpoint.control_intents.filter((intent) => intent.operation === operation)
}

async function waitFor(description, predicate, timeoutMs = 8_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) {
      return result
    }

    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs)
    })
  }

  throw new Error(`Timed out waiting for ${description}`)
}

async function createGeneralChannel(client, label) {
  const server = await client.createServer(label)
  const channel = server.channels.find((entry) => entry.name === 'general') ?? null
  assert.ok(channel, 'expected the default general channel')
  return channel
}

async function approveAndUnlockSecondary(primaryClient, secondaryClient, secondaryDeviceId, username, password) {
  const session = await secondaryClient.login(username, password)
  assert.equal(session.currentDevice?.trust_state, 'pending')
  assert.equal(session.canUseE2EE, false)

  const pendingDevice = await waitFor('secondary device approval visibility', async () => {
    const state = await primaryClient.fetchDevices()
    return state.devices.find((device) => device.client_id === secondaryDeviceId) ?? null
  })

  await primaryClient.approveDevice(pendingDevice.id)

  await waitFor('secondary device trusted state', async () => {
    const state = await secondaryClient.fetchDevices()
    return state.currentDevice?.trust_state === 'trusted' ? state : null
  })

  const unlocked = await secondaryClient.unlockTrustedDevice(password)
  assert.equal(unlocked.canUseE2EE, true)
}

test('sdk hydrates the durable workspace before a reconnect sync response arrives', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const first = createClientHarness(stack.apiUrl, 'workspace-cache')
  const username = uniqueUsername('sdkcache')
  const password = 'vesper-sdk-cache-password'
  await first.client.register(username, password)
  const server = await first.client.createServer('Cached workspace')
  await first.client.syncNow(true)
  first.client.stop()

  let releaseSync
  const syncGate = new Promise((resolve) => {
    releaseSync = resolve
  })
  let observeSync
  const syncObserved = new Promise((resolve) => {
    observeSync = resolve
  })

  const second = createClientHarness(stack.apiUrl, 'workspace-cache-restart', {
    device: first.device,
    sessionStore: first.sessionStore,
    storage: first.storage,
    fetchImpl: async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/v1/sync')) {
        observeSync()
        await syncGate
      }
      return await fetch(input, init)
    }
  })

  assert.ok(await second.client.restoreSession())
  const startPromise = second.client.start(false)
  await syncObserved

  const hydrated = second.client.getState()
  assert.equal(hydrated.servers.some((entry) => entry.id === server.id), true)
  assert.ok(hydrated.syncToken)

  releaseSync()
  await startPromise
  second.client.stop()
})

test('sdk replaces stale local workspace when the server forces a compact snapshot', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const first = createClientHarness(stack.apiUrl, 'workspace-expiry')
  const username = uniqueUsername('sdkexpiry')
  const password = 'vesper-sdk-expiry-password'
  await first.client.register(username, password)
  const staleServer = await first.client.createServer('Stale local server')
  await first.client.syncNow(true)
  first.client.stop()

  const second = createClientHarness(stack.apiUrl, 'workspace-expiry-restart', {
    device: first.device,
    sessionStore: first.sessionStore,
    storage: first.storage,
    fetchImpl: async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/v1/sync')) {
        return new Response(
          JSON.stringify({
            token: 'fresh-snapshot-token',
            full: true,
            has_more: false,
            servers: [],
            conversations: [],
            conversations_has_more: false,
            conversations_next_cursor: null,
            conversation_resets: [],
            channel_activity: [],
            unread_counts: { channels: {}, conversations: {} }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      return await fetch(input, init)
    }
  })

  assert.ok(await second.client.restoreSession())
  await second.client.start(false)
  assert.equal(second.client.getState().servers.some((entry) => entry.id === staleServer.id), false)
  second.client.stop()
})

test('sdk client keeps a single encrypted runtime and fan-outs scope watchers', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const { client, sessionStore } = createClientHarness(stack.apiUrl, 'fanout')
  const username = uniqueUsername('sdkfan')
  const password = 'vesper-sdk-dx-password'
  const senderSocket = new VesperSocketClient({
    getAccessToken: () => sessionStore.getAccessToken(),
    getServerUrl: () => sessionStore.getServerUrl(),
    logger: {
      error: () => {},
      log: () => {}
    }
  })

  try {
    await client.register(username, password)
    await client.start(false)

    const encryptedA = client.createEncryptedChat()
    const encryptedB = client.createEncryptedChat()
    assert.equal(encryptedA, encryptedB)

    const channel = await createGeneralChannel(client, `SDK Fanout ${Date.now()}`)
    let firstHits = 0
    let secondHits = 0

    const disposeFirst = await client.watchScope('channel', channel.id, ({ event }) => {
      if (event === 'typing_start') {
        firstHits += 1
      }
    })
    const disposeSecond = await client.watchScope('channel', channel.id, ({ event }) => {
      if (event === 'typing_start') {
        secondHits += 1
      }
    })

    senderSocket.connect()
    await senderSocket.joinChannelWithAck(`chat:channel:${channel.id}`, () => {})
    senderSocket.pushToChannel(`chat:channel:${channel.id}`, 'typing_start', {})

    await waitFor('both scope listeners to receive the same event', async () => {
      return firstHits >= 1 && secondHits >= 1
    })

    disposeFirst()
    disposeSecond()
  } finally {
    senderSocket.disconnect()
    client.stop()
  }
})

test('sdk scope watcher recovery preserves registered listeners after a failed push acknowledgement', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const { client, sessionStore } = createClientHarness(stack.apiUrl, 'watcher-recovery')
  const username = uniqueUsername('sdkwatcher')
  const password = 'vesper-sdk-watcher-recovery-password'
  const senderSocket = new VesperSocketClient({
    getAccessToken: () => sessionStore.getAccessToken(),
    getServerUrl: () => sessionStore.getServerUrl(),
    logger: {
      error: () => {},
      log: () => {}
    }
  })

  try {
    await client.register(username, password)
    await client.start(false)

    const channel = await createGeneralChannel(client, `SDK Watcher Recovery ${Date.now()}`)
    let hits = 0
    const dispose = await client.watchScope('channel', channel.id, ({ event }) => {
      if (event === 'typing_start') {
        hits += 1
      }
    })

    const originalPushWithAck = client.socketClient.pushToChannelWithAck.bind(client.socketClient)
    let pushAttempts = 0
    client.socketClient.pushToChannelWithAck = async () => {
      pushAttempts += 1
      return pushAttempts > 1
    }

    try {
      assert.equal(
        await client.pushScopeEvent('channel', channel.id, 'pin_message', { message_id: 'unused' }),
        true
      )
    } finally {
      client.socketClient.pushToChannelWithAck = originalPushWithAck
    }

    assert.equal(pushAttempts, 2)

    senderSocket.connect()
    await senderSocket.joinChannelWithAck(`chat:channel:${channel.id}`, () => {})
    senderSocket.pushToChannel(`chat:channel:${channel.id}`, 'typing_start', {})

    await waitFor('recovered scope watcher listener to receive a later event', async () => hits === 1)
    dispose()
  } finally {
    senderSocket.disconnect()
    client.stop()
  }
})

test('sdk retries an ambiguous message acknowledgement with the same logical send', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const { client } = createClientHarness(stack.apiUrl, 'message-ack-retry')
  const username = uniqueUsername('sdkackretry')
  const password = 'vesper-sdk-message-ack-retry-password'

  try {
    await client.register(username, password)
    await client.start(false)

    const chat = client.createEncryptedChat()
    const channel = await createGeneralChannel(client, `SDK Ack Retry ${Date.now()}`)
    const scope = { kind: 'channel', id: channel.id }
    const text = `retry-once-${Date.now()}`

    await chat.watchScope(scope)
    assert.equal(await chat.ensureScopeReady(scope, true), true)

    const originalPushWithAck = client.socketClient.pushToChannelWithAck.bind(client.socketClient)
    let pushAttempts = 0
    client.socketClient.pushToChannelWithAck = async (...args) => {
      pushAttempts += 1
      if (pushAttempts <= 2) {
        return false
      }
      return await originalPushWithAck(...args)
    }

    try {
      await chat.sendText(scope, text)
    } finally {
      client.socketClient.pushToChannelWithAck = originalPushWithAck
    }

    assert.equal(pushAttempts, 3)

    const messages = await waitFor('single idempotent message after ack retry', async () => {
      const synced = await chat.syncScope(scope, { limit: 20 })
      const matching = synced.messages.filter((message) => message.content === text)
      return matching.length === 1 ? matching : null
    })
    assert.equal(messages.length, 1)
  } finally {
    client.stop()
  }
})

test('sdk transport treats unjoined channels as unusable', () => {
  const socket = new VesperSocketClient({
    getAccessToken: () => null,
    getServerUrl: () => 'http://127.0.0.1:4000',
    logger: {
      error: () => {},
      log: () => {}
    }
  })

  socket.channels.set('chat:channel:stale', {
    isJoined: () => false,
    isClosed: () => false,
    isLeaving: () => false
  })
  socket.channels.set('chat:channel:joined', {
    isJoined: () => true,
    isClosed: () => false,
    isLeaving: () => false
  })

  assert.equal(socket.hasUsableChannel('chat:channel:stale'), false)
  assert.equal(socket.hasUsableChannel('chat:channel:joined'), true)
})

test('sdk scope sync applies offline mutation events and deleted messages stay gone after reload', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const { client } = createClientHarness(stack.apiUrl, 'offline-sync')
  const username = uniqueUsername('sdkoff')
  const password = 'vesper-sdk-offline-password'

  try {
    await client.register(username, password)
    await client.start(false)

    const chat = client.createEncryptedChat()
    const channel = await createGeneralChannel(client, `SDK Offline ${Date.now()}`)
    const scope = { kind: 'channel', id: channel.id }

    await chat.watchScope(scope)
    const ready = await chat.ensureScopeReady(scope, true)
    assert.equal(ready, true)

    await chat.sendText(scope, 'first pass')
    const baseline = await waitFor('baseline encrypted message', async () => {
      const synced = await chat.syncScope(scope, { limit: 10 })
      return synced.messages.find((message) => message.content === 'first pass') ?? null
    })

    client.stop()

    await chat.editText(scope, baseline.id, 'edited while offline')
    const edited = await waitFor('edit event in sync response', async () => {
      const synced = await chat.syncScope(scope, { limit: 10 })
      if (synced.events.some((event) => event.eventType === 'message_edited')) {
        return synced
      }
      return null
    })
    const editedMessage = edited.messages.find((message) => message.id === baseline.id) ?? null

    assert.ok(edited.events.some((event) => event.eventType === 'message_edited'))
    assert.equal(editedMessage?.content, 'edited while offline')
    assert.equal(editedMessage?.decryptionFailed, false)

    client.stop()

    await chat.deleteMessage(scope, baseline.id)
    const deleted = await waitFor('delete event in sync response', async () => {
      const synced = await chat.syncScope(scope, { limit: 10 })
      if (synced.events.some((event) => event.eventType === 'message_deleted')) {
        return synced
      }
      return null
    })

    assert.ok(deleted.events.some((event) => event.eventType === 'message_deleted'))
    assert.equal(
      deleted.messages.some((message) => message.id === baseline.id),
      false
    )

    chat.reset()
    const reloaded = await chat.syncScope(scope, { limit: 10 })
    assert.equal(
      reloaded.messages.some((message) => message.id === baseline.id),
      false
    )
  } finally {
    client.stop()
  }
})

test('sdk createScopeGroup reports a failed initial GroupInfo publish', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const { client } = createClientHarness(stack.apiUrl, 'group-info-failure')
  const username = uniqueUsername('sdkgif')
  const password = 'vesper-sdk-group-info-password'

  try {
    await client.register(username, password)
    await client.start(false)

    const chat = client.createEncryptedChat()
    const channel = await createGeneralChannel(client, `SDK GroupInfo ${Date.now()}`)
    const scope = { kind: 'channel', id: channel.id }
    const httpClient = client.getHttpClient()
    const originalApiFetch = httpClient.apiFetch.bind(httpClient)
    const groupInfoPath = `/api/v1/group-info/${encodeURIComponent(channel.id)}`

    httpClient.apiFetch = async (path, options = {}) => {
      if (path === groupInfoPath && options.method === 'PUT') {
        return new Response(JSON.stringify({ error: 'forced failure' }), {
          status: 503,
          headers: {
            'Content-Type': 'application/json'
          }
        })
      }

      return await originalApiFetch(path, options)
    }

    try {
      const created = await chat.createScopeGroup(scope)

      assert.equal(created, false)
      assert.equal(chat.hasGroup(channel.id), true)

      const originalPushScopeEvent = client.pushScopeEvent.bind(client)
      let pushedJoinAll = false
      client.pushScopeEvent = async (kind, scopeId, event, payload) => {
        if (kind === scope.kind && scopeId === scope.id && event === 'mls_request_join_all') {
          pushedJoinAll = true
        }

        return await originalPushScopeEvent(kind, scopeId, event, payload)
      }

      try {
        await assert.rejects(chat.requestJoinAll(scope))
        assert.equal(pushedJoinAll, false)
      } finally {
        client.pushScopeEvent = originalPushScopeEvent
      }
    } finally {
      httpClient.apiFetch = originalApiFetch
    }
  } finally {
    client.stop()
  }
})

test('sdk flushes a persisted GroupInfo publish after restart', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const shared = createClientHarness(stack.apiUrl, 'group-info-restart')
  const username = uniqueUsername('sdkgifr')
  const password = 'vesper-sdk-group-info-restart-password'

  try {
    await shared.client.register(username, password)
    await shared.client.start(false)

    const chat = shared.client.createEncryptedChat()
    const channel = await createGeneralChannel(shared.client, `SDK GroupInfo Restart ${Date.now()}`)
    const scope = { kind: 'channel', id: channel.id }
    const httpClient = shared.client.getHttpClient()
    const originalApiFetch = httpClient.apiFetch.bind(httpClient)
    const groupInfoPath = `/api/v1/group-info/${encodeURIComponent(channel.id)}`

    httpClient.apiFetch = async (path, options = {}) => {
      if (path === groupInfoPath && options.method === 'PUT') {
        return new Response(JSON.stringify({ error: 'forced restart failure' }), {
          status: 503,
          headers: {
            'Content-Type': 'application/json'
          }
        })
      }

      return await originalApiFetch(path, options)
    }

    try {
      const created = await chat.createScopeGroup(scope)
      assert.equal(created, false)
      assert.equal(chat.hasGroup(channel.id), true)

      const pendingPublishes = await loadControlIntents(
        shared.storage,
        channel.id,
        'group_info_publish'
      )
      assert.equal(pendingPublishes.length, 1)
      assert.equal(pendingPublishes[0]?.scope_id, channel.id)
    } finally {
      httpClient.apiFetch = originalApiFetch
    }

    shared.client.stop()

    const restarted = createClientHarness(stack.apiUrl, 'group-info-restart-second', {
      device: shared.device,
      sessionStore: shared.sessionStore,
      storage: shared.storage
    })
    const restartedChat = restarted.client.createEncryptedChat()

    try {
      await restarted.client.start(false)

      await waitFor('pending GroupInfo publish to flush after restart', async () => {
        const pendingPublishes = await loadControlIntents(
          shared.storage,
          channel.id,
          'group_info_publish'
        )
        if (pendingPublishes.length !== 0) {
          return false
        }

        const response = await restarted.client.getHttpClient().apiFetch(groupInfoPath)
        return response.ok
      })

      assert.equal(restartedChat.hasGroup(channel.id), false)
    } finally {
      restarted.client.stop()
    }
  } finally {
    shared.client.stop()
  }
})

test('sdk flushes a persisted message send after a crash between local send and server ack', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const shared = createClientHarness(stack.apiUrl, 'send-outbox-restart')
  const username = uniqueUsername('sdksendoutbox')
  const password = 'vesper-sdk-send-outbox-password'

  try {
    await shared.client.register(username, password)
    await shared.client.start(false)

    const chat = shared.client.createEncryptedChat()
    const channel = await createGeneralChannel(shared.client, `SDK Send Outbox ${Date.now()}`)
    const scope = { kind: 'channel', id: channel.id }

    await chat.watchScope(scope)
    const ready = await chat.ensureScopeReady(scope, true)
    assert.equal(ready, true)

    // Simulate a real crash: the network write never resolves (hangs, as a
    // dropped connection or a killed process would look from the caller's
    // perspective), so sendPayload's own catch/finally never gets a chance
    // to run and clear the outbox entry. We never await this call — a crash
    // wouldn't wait for it either.
    const originalPushScopeEvent = shared.client.pushScopeEvent.bind(shared.client)
    shared.client.pushScopeEvent = async (kind, scopeId, event, payload) => {
      if (kind === scope.kind && scopeId === scope.id && event === 'new_message') {
        return await new Promise(() => {}) // never resolves
      }

      return await originalPushScopeEvent(kind, scopeId, event, payload)
    }

    void chat.sendText(scope, 'crash-before-ack').catch(() => {})

    const pendingSends = await waitFor('pending send to be persisted before the crash', async () => {
      const entries = await shared.storage.getPendingMessageSends()
      return entries.length > 0 ? entries : null
    })
    assert.equal(pendingSends.length, 1)
    assert.equal(pendingSends[0]?.scope_id, channel.id)

    shared.client.pushScopeEvent = originalPushScopeEvent
    shared.client.stop()

    const restarted = createClientHarness(stack.apiUrl, 'send-outbox-restart-second', {
      device: shared.device,
      sessionStore: shared.sessionStore,
      storage: shared.storage
    })
    const restartedChat = restarted.client.createEncryptedChat()

    try {
      await restarted.client.start(false)
      await restartedChat.watchScope(scope)

      const delivered = await waitFor('pending message send to flush after restart', async () => {
        const remaining = await shared.storage.getPendingMessageSends()
        if (remaining.length !== 0) {
          return null
        }

        const synced = await restartedChat.syncScope(scope, { limit: 10 })
        return synced.messages.find((message) => message.content === 'crash-before-ack') ?? null
      })

      assert.equal(delivered.decryptionFailed, false)

      // Confirm the retry never produced a duplicate — the server's
      // (scope, sender, client_nonce) unique index plus the outbox's stable
      // nonce is what makes the crash-recovery retry safe.
      const finalSync = await restartedChat.syncScope(scope, { limit: 10 })
      const matches = finalSync.messages.filter(
        (message) => message.content === 'crash-before-ack'
      )
      assert.equal(matches.length, 1)
    } finally {
      restarted.client.stop()
    }
  } finally {
    shared.client.stop()
  }
})

test('sdk flushes a persisted sponsored transition after restart', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const primaryShared = createClientHarness(stack.apiUrl, 'sponsored-primary')
  const secondary = createClientHarness(stack.apiUrl, 'sponsored-secondary')
  const username = uniqueUsername('sdksponsored')
  const password = 'vesper-sdk-sponsored-restart-password'

  try {
    await primaryShared.client.register(username, password)
    await primaryShared.client.start(false)

    await approveAndUnlockSecondary(
      primaryShared.client,
      secondary.client,
      secondary.device.id,
      username,
      password
    )
    await secondary.client.start(false)

    const primaryChat = primaryShared.client.createEncryptedChat()
    const secondaryChat = secondary.client.createEncryptedChat()
    const channel = await createGeneralChannel(primaryShared.client, `SDK Sponsored Restart ${Date.now()}`)
    const scope = { kind: 'channel', id: channel.id }

    await primaryChat.watchScope(scope)
    assert.equal(await primaryChat.createScopeGroup(scope), true)
    assert.equal(primaryChat.getGroupEpoch(channel.id), 0)

    const httpClient = primaryShared.client.getHttpClient()
    const originalApiFetch = httpClient.apiFetch.bind(httpClient)
    const sponsoredPath = `/api/v1/mls-sponsored-transition/${encodeURIComponent(channel.id)}`
    httpClient.apiFetch = async (path, options = {}) => {
      if (path === sponsoredPath && options.method === 'POST') {
        return new Response(JSON.stringify({ error: 'forced sponsored transition failure' }), {
          status: 503,
          headers: {
            'Content-Type': 'application/json'
          }
        })
      }

      return await originalApiFetch(path, options)
    }

    try {
      const session = primaryShared.client.getAuthSession()
      assert.ok(session, 'expected a primary auth session')

      const sponsored = await primaryChat.sponsorScopeResync(
        channel.id,
        session.user.id,
        secondary.device.id
      )

      assert.equal(sponsored, false)

      const pending = await loadControlIntents(
        primaryShared.storage,
        channel.id,
        'sponsored_transition'
      )
      assert.equal(pending.length, 1)
      assert.equal(pending[0]?.scope_id, channel.id)

      // The failed transition is durable only as an idempotent intent. Its
      // checkpoint must remain at the pre-transition MLS epoch until the
      // server assigns durable event sequences.
      assert.equal(primaryChat.getGroupEpoch(channel.id), 0)
      const stagedCheckpoint = await primaryShared.storage.getScopeCheckpoint(channel.id)
      assert.equal(stagedCheckpoint.epoch, 0)
      assert.equal(stagedCheckpoint.last_event_seq, 0)
      assert.equal(secondaryChat.hasGroup(channel.id), false)
    } finally {
      httpClient.apiFetch = originalApiFetch
    }

    primaryShared.client.stop()

    const restartedPrimary = createClientHarness(stack.apiUrl, 'sponsored-primary-restart', {
      device: primaryShared.device,
      sessionStore: primaryShared.sessionStore,
      storage: primaryShared.storage
    })
    const restartedPrimaryChat = restartedPrimary.client.createEncryptedChat()

    try {
      await restartedPrimary.client.start(false)
      await restartedPrimaryChat.watchScope(scope)

      await waitFor('pending sponsored transition to flush after restart', async () => {
        const pending = await loadControlIntents(
          primaryShared.storage,
          channel.id,
          'sponsored_transition'
        )
        return pending.length === 0
      })

      await secondaryChat.watchScope(scope)
      await waitFor('secondary device to receive the sponsored resync', async () => {
        return await secondaryChat.ensureMembership(scope)
      })

      await waitFor('post-transition GroupInfo publish to flush', async () => {
        const pending = await loadControlIntents(
          primaryShared.storage,
          channel.id,
          'group_info_publish'
        )
        return pending.length === 0
      })

      assert.equal(secondaryChat.getGroupEpoch(channel.id), 1)
      const appliedCheckpoint = await primaryShared.storage.getScopeCheckpoint(channel.id)
      assert.equal(appliedCheckpoint.epoch, 1)
      assert.ok(appliedCheckpoint.last_event_seq > 0)
    } finally {
      restartedPrimary.client.stop()
    }
  } finally {
    primaryShared.client.stop()
    secondary.client.stop()
  }
})

test('sdk rolls a losing sponsor back onto the winning epoch', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const owner = createClientHarness(stack.apiUrl, 'sponsor-race-owner')
  const friend = createClientHarness(stack.apiUrl, 'sponsor-race-friend')
  const secondaryOwner = createClientHarness(stack.apiUrl, 'sponsor-race-owner-secondary')
  const secondaryFriend = createClientHarness(stack.apiUrl, 'sponsor-race-friend-secondary')
  const ownerUsername = uniqueUsername('sdksponsorowner')
  const friendUsername = uniqueUsername('sdksponsorfriend')
  const password = 'vesper-sdk-sponsored-race-password'

  try {
    await owner.client.register(ownerUsername, password)
    await friend.client.register(friendUsername, password)
    await owner.client.start(false)
    await friend.client.start(false)

    await approveAndUnlockSecondary(
      owner.client,
      secondaryOwner.client,
      secondaryOwner.device.id,
      ownerUsername,
      password
    )
    await approveAndUnlockSecondary(
      friend.client,
      secondaryFriend.client,
      secondaryFriend.device.id,
      friendUsername,
      password
    )

    const ownerChat = owner.client.createEncryptedChat()
    const friendChat = friend.client.createEncryptedChat()
    const secondaryOwnerChat = secondaryOwner.client.createEncryptedChat()
    const secondaryFriendChat = secondaryFriend.client.createEncryptedChat()

    const server = await owner.client.createServer(`SDK Sponsored Race ${Date.now()}`)
    const channel = server.channels.find((entry) => entry.name === 'general') ?? null
    assert.ok(channel, 'expected the default general channel')
    const invite = await owner.client.createServerInvite(server.id, {})
    await friend.client.joinServerByInvite(invite.code)

    const scope = { kind: 'channel', id: channel.id }
    await ownerChat.watchScope(scope)
    await friendChat.watchScope(scope)

    assert.equal(await ownerChat.createScopeGroup(scope), true)
    assert.equal(await friendChat.ensureMembership(scope), true)

    await waitFor('owner and friend to share epoch 1', async () => {
      return ownerChat.getGroupEpoch(channel.id) === 1 && friendChat.getGroupEpoch(channel.id) === 1
    })

    const ownerSession = owner.client.getAuthSession()
    const friendSession = friend.client.getAuthSession()
    assert.ok(ownerSession, 'expected an owner auth session')
    assert.ok(friendSession, 'expected a friend auth session')

    const sponsoredPath = `/api/v1/mls-sponsored-transition/${encodeURIComponent(channel.id)}`
    const ownerHttp = owner.client.getHttpClient()
    const friendHttp = friend.client.getHttpClient()
    const originalOwnerApiFetch = ownerHttp.apiFetch.bind(ownerHttp)
    const originalFriendApiFetch = friendHttp.apiFetch.bind(friendHttp)
    let readyCount = 0
    let releaseBarrier = null
    let barrierTimeout = null
    const barrier = new Promise((resolve, reject) => {
      releaseBarrier = resolve
      barrierTimeout = setTimeout(() => {
        reject(new Error('Timed out waiting for both sponsored transitions to reach the CAS boundary'))
      }, 10_000)
    })

    ownerHttp.apiFetch = async (path, options = {}) => {
      if (path === sponsoredPath && options.method === 'POST') {
        readyCount += 1
        if (readyCount === 2) {
          clearTimeout(barrierTimeout)
          barrierTimeout = null
          releaseBarrier?.()
        }
        await barrier
      }

      return await originalOwnerApiFetch(path, options)
    }

    friendHttp.apiFetch = async (path, options = {}) => {
      if (path === sponsoredPath && options.method === 'POST') {
        readyCount += 1
        if (readyCount === 2) {
          clearTimeout(barrierTimeout)
          barrierTimeout = null
          releaseBarrier?.()
        }
        await barrier
      }

      return await originalFriendApiFetch(path, options)
    }

    try {
      await waitFor('both sponsors to observe the same predecessor epoch', async () => {
        return ownerChat.getGroupEpoch(channel.id) === friendChat.getGroupEpoch(channel.id)
      })
      const sponsorshipBaseEpoch = ownerChat.getGroupEpoch(channel.id)
      assert.ok(sponsorshipBaseEpoch != null)

      const [ownerSponsored, friendSponsored] = await Promise.all([
        ownerChat.sponsorScopeResync(channel.id, ownerSession.user.id, secondaryOwner.device.id),
        friendChat.sponsorScopeResync(channel.id, friendSession.user.id, secondaryFriend.device.id)
      ])

      assert.equal(
        [ownerSponsored, friendSponsored].filter(Boolean).length,
        1,
        'expected exactly one sponsor to win the CAS'
      )

      const convergedEpoch = await waitFor('both sponsors to converge on one winning epoch', async () => {
        const ownerEpoch = ownerChat.getGroupEpoch(channel.id)
        const friendEpoch = friendChat.getGroupEpoch(channel.id)
        return ownerEpoch != null && ownerEpoch > sponsorshipBaseEpoch && ownerEpoch === friendEpoch
          ? ownerEpoch
          : null
      })
      assert.equal(convergedEpoch, sponsorshipBaseEpoch + 1)

      const winningSecondary = ownerSponsored ? secondaryOwner : secondaryFriend
      const winningSecondaryChat = ownerSponsored ? secondaryOwnerChat : secondaryFriendChat
      await winningSecondary.client.start(false)
      await winningSecondaryChat.watchScope(scope)
      await waitFor('winning secondary device to join from its sponsored Welcome', async () => {
        return await winningSecondaryChat.ensureMembership(scope)
      })

      assert.equal(
        (await loadControlIntents(owner.storage, channel.id, 'sponsored_transition')).length,
        0
      )
      assert.equal(
        (await loadControlIntents(friend.storage, channel.id, 'sponsored_transition')).length,
        0
      )
      assert.equal(ownerChat.hasGroup(channel.id), true)
      assert.equal(friendChat.hasGroup(channel.id), true)
    } finally {
      if (barrierTimeout) {
        clearTimeout(barrierTimeout)
      }
      ownerHttp.apiFetch = originalOwnerApiFetch
      friendHttp.apiFetch = originalFriendApiFetch
    }
  } finally {
    owner.client.stop()
    friend.client.stop()
    secondaryOwner.client.stop()
    secondaryFriend.client.stop()
  }
})

test('sdk external commit is durably stored and broadcast without a client-side commit push', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const owner = createClientHarness(stack.apiUrl, 'external-owner')
  const joinerShared = createClientHarness(stack.apiUrl, 'external-joiner-shared')
  const ownerUsername = uniqueUsername('sdkowner')
  const joinerUsername = uniqueUsername('sdkjoiner')
  const password = 'vesper-sdk-external-commit-password'

  try {
    await owner.client.register(ownerUsername, password)
    await joinerShared.client.register(joinerUsername, password)
    await owner.client.start(false)
    await joinerShared.client.start(false)

    const ownerChat = owner.client.createEncryptedChat()
    const joinerChat = joinerShared.client.createEncryptedChat()
    const server = await owner.client.createServer(`SDK External Commit ${Date.now()}`)
    const channel = server.channels.find((entry) => entry.name === 'general') ?? null
    assert.ok(channel, 'expected the default general channel')
    const invite = await owner.client.createServerInvite(server.id, {})
    await joinerShared.client.joinServerByInvite(invite.code)
    const scope = { kind: 'channel', id: channel.id }

    await ownerChat.watchScope(scope)
    assert.equal(await ownerChat.createScopeGroup(scope), true)
    assert.equal(ownerChat.getGroupEpoch(channel.id), 0)

    const originalPushMlsControlEvent = joinerChat.pushMlsControlEvent.bind(joinerChat)

    joinerChat.pushMlsControlEvent = async (scopeId, event, payload, topic = null) => {
      if (scopeId === channel.id && event === 'mls_commit') {
        return false
      }

      return await originalPushMlsControlEvent(scopeId, event, payload, topic)
    }

    try {
      const joined = await joinerChat.ensureMembership(scope)
      assert.equal(joined, true)

      await waitFor('owner to apply the external commit broadcast from the server', async () => {
        return ownerChat.getGroupEpoch(channel.id) === 1
      })

      const pendingBroadcasts = await loadControlIntents(
        joinerShared.storage,
        channel.id,
        'external_commit_broadcast'
      )
      assert.equal(pendingBroadcasts.length, 0)
      assert.equal(joinerChat.getGroupEpoch(channel.id), 1)
    } finally {
      joinerChat.pushMlsControlEvent = originalPushMlsControlEvent
    }
  } finally {
    owner.client.stop()
    joinerShared.client.stop()
  }
})

test('sdk coalesces concurrent durable replay and preserves ordered multi-commit state', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const owner = createClientHarness(stack.apiUrl, 'replay-owner')
  const firstJoiner = createClientHarness(stack.apiUrl, 'replay-first-joiner')
  const secondJoiner = createClientHarness(stack.apiUrl, 'replay-second-joiner')
  const password = 'vesper-sdk-concurrent-replay-password'

  try {
    await owner.client.register(uniqueUsername('sdkreplayowner'), password)
    await firstJoiner.client.register(uniqueUsername('sdkreplayfirst'), password)
    await secondJoiner.client.register(uniqueUsername('sdkreplaysecond'), password)
    await owner.client.start(false)
    await firstJoiner.client.start(false)
    await secondJoiner.client.start(false)

    const ownerChat = owner.client.createEncryptedChat()
    const firstJoinerChat = firstJoiner.client.createEncryptedChat()
    const secondJoinerChat = secondJoiner.client.createEncryptedChat()
    const server = await owner.client.createServer(`SDK Concurrent Replay ${Date.now()}`)
    const channel = server.channels.find((entry) => entry.name === 'general') ?? null
    assert.ok(channel, 'expected the default general channel')
    const invite = await owner.client.createServerInvite(server.id, {})
    await firstJoiner.client.joinServerByInvite(invite.code)
    await secondJoiner.client.joinServerByInvite(invite.code)
    const scope = { kind: 'channel', id: channel.id }

    assert.equal(await ownerChat.createScopeGroup(scope), true)
    assert.equal(ownerChat.getGroupEpoch(channel.id), 0)
    assert.equal(await firstJoinerChat.ensureMembership(scope), true)
    assert.equal(firstJoinerChat.getGroupEpoch(channel.id), 1)
    assert.equal(await secondJoinerChat.ensureMembership(scope), true)
    assert.equal(secondJoinerChat.getGroupEpoch(channel.id), 2)
    assert.equal(ownerChat.getGroupEpoch(channel.id), 0)

    const ownerHttp = owner.client.getHttpClient()
    const originalApiFetch = ownerHttp.apiFetch.bind(ownerHttp)
    let replayFetches = 0
    let signalReplayStarted = () => {}
    const replayStarted = new Promise((resolve) => {
      signalReplayStarted = resolve
    })
    let releaseReplay = () => {}
    const replayGate = new Promise((resolve) => {
      releaseReplay = resolve
    })

    ownerHttp.apiFetch = async (...args) => {
      if (String(args[0]).includes(`/api/v1/mls-events/${channel.id}`)) {
        replayFetches += 1
        signalReplayStarted()
        await replayGate
      }
      return await originalApiFetch(...args)
    }

    let lockedMutationRan = false
    try {
      const replay = async () => await owner.client.runWithStorageContext(async () => {
        await ownerChat.replayDurableEvents(channel.id)
      })
      const replays = Promise.all([replay(), replay(), replay(), replay()])
      await replayStarted

      const lockedMutation = ownerChat.withLockedScopeOperation(channel.id, async () => {
        lockedMutationRan = true
      })
      await new Promise((resolve) => setTimeout(resolve, 25))
      assert.equal(lockedMutationRan, false, 'replay must retain the group lock while fetching')

      releaseReplay()
      await Promise.all([replays, lockedMutation])
    } finally {
      releaseReplay()
      ownerHttp.apiFetch = originalApiFetch
    }

    assert.equal(replayFetches, 1)
    assert.equal(lockedMutationRan, true)
    assert.equal(ownerChat.getGroupEpoch(channel.id), 2)
    assert.equal(ownerChat.getMemberCount(channel.id), 3)

    const checkpoint = await owner.storage.getScopeCheckpoint(channel.id)
    assert.equal(checkpoint.epoch, 2)
    assert.ok(checkpoint.last_event_seq > 0)
  } finally {
    owner.client.stop()
    firstJoiner.client.stop()
    secondJoiner.client.stop()
  }
})

test('sdk applies live commits through the durable cursor and preserves them across restart', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const ownerShared = createClientHarness(stack.apiUrl, 'live-replay-owner')
  const joiner = createClientHarness(stack.apiUrl, 'live-replay-joiner')
  const ownerUsername = uniqueUsername('sdkliveowner')
  const joinerUsername = uniqueUsername('sdklivejoiner')
  const password = 'vesper-sdk-live-replay-password'

  try {
    await ownerShared.client.register(ownerUsername, password)
    await joiner.client.register(joinerUsername, password)
    await ownerShared.client.start(false)
    await joiner.client.start(false)

    const ownerChat = ownerShared.client.createEncryptedChat()
    const joinerChat = joiner.client.createEncryptedChat()
    const server = await ownerShared.client.createServer(`SDK Live Replay ${Date.now()}`)
    const channel = server.channels.find((entry) => entry.name === 'general') ?? null
    assert.ok(channel, 'expected the default general channel')
    const invite = await ownerShared.client.createServerInvite(server.id, {})
    await joiner.client.joinServerByInvite(invite.code)
    const scope = { kind: 'channel', id: channel.id }

    await ownerChat.watchScope(scope)
    await joinerChat.watchScope(scope)
    assert.equal(await ownerChat.createScopeGroup(scope), true)
    assert.equal(await joinerChat.ensureMembership(scope), true)

    await waitFor('owner to apply the live external commit', async () => {
      return ownerChat.getGroupEpoch(channel.id) === 1
    })

    assert.ok(await ownerShared.storage.getGroupSyncCursor(channel.id) >= 1)

    const checkpointBeforeRestart = await ownerShared.storage.getScopeCheckpoint(channel.id)
    assert.ok(
      checkpointBeforeRestart.recent_commit_fingerprints.length > 0,
      'expected a persisted recent commit fingerprint before restart'
    )

    ownerShared.storage.setGroupSyncCursor = async () => {
      throw new Error('durable replay must advance through the atomic scope checkpoint')
    }

    ownerShared.client.stop()

    const restartedOwner = createClientHarness(stack.apiUrl, 'live-replay-owner-restart', {
      device: ownerShared.device,
      sessionStore: ownerShared.sessionStore,
      storage: ownerShared.storage
    })
    const restartedChat = restartedOwner.client.createEncryptedChat()

    try {
      await restartedOwner.client.start(false)
      await restartedChat.watchScope(scope)
      assert.equal(await restartedChat.ensureMembership(scope), true)

      await restartedChat.replayScopeEvents(channel.id)

      await waitFor('durable replay cursor to remain advanced after restart', async () => {
        return (await ownerShared.storage.getGroupSyncCursor(channel.id)) >= 1
      })

      assert.equal(restartedChat.getGroupEpoch(channel.id), 1)
    } finally {
      restartedOwner.client.stop()
    }
  } finally {
    ownerShared.client.stop()
    joiner.client.stop()
  }
})

test('sdk replays a room gap before applying an out-of-order live MLS message', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const owner = createClientHarness(stack.apiUrl, 'room-order-owner')
  const receiver = createClientHarness(stack.apiUrl, 'room-order-receiver')
  const ownerUsername = uniqueUsername('sdkroomorderowner')
  const receiverUsername = uniqueUsername('sdkroomorderreceiver')
  const password = 'vesper-sdk-room-order-password'

  try {
    await owner.client.register(ownerUsername, password)
    await receiver.client.register(receiverUsername, password)
    await owner.client.start(false)
    await receiver.client.start(false)

    const ownerChat = owner.client.createEncryptedChat()
    const receiverChat = receiver.client.createEncryptedChat()
    const server = await owner.client.createServer(`SDK Room Order ${Date.now()}`)
    const channel = server.channels.find((entry) => entry.name === 'general') ?? null
    assert.ok(channel, 'expected the default general channel')
    const invite = await owner.client.createServerInvite(server.id, {})
    await receiver.client.joinServerByInvite(invite.code)
    const scope = { kind: 'channel', id: channel.id }

    await ownerChat.watchScope(scope)
    await receiverChat.watchScope(scope)
    assert.equal(await ownerChat.createScopeGroup(scope), true)
    assert.equal(await receiverChat.ensureMembership(scope), true)
    receiver.client.stop()

    const expected = ['room-order-one', 'room-order-two', 'room-order-three']
    for (const text of expected) {
      await ownerChat.sendText(scope, text)
    }

    const rawMessages = (await receiver.client.fetchChannelMessages(channel.id, { limit: 20 }))
      .filter((message) => expected.includes(message.content ?? '') || message.ciphertext)
      .sort((left, right) => (left.room_seq ?? 0) - (right.room_seq ?? 0))
      .slice(-expected.length)
    assert.equal(rawMessages.length, expected.length)

    const newestFirst = await receiverChat.processScopeEvent(
      scope,
      'new_message',
      rawMessages.at(-1)
    )
    assert.equal(newestFirst?.message?.decryptionFailed, false)

    for (const rawMessage of rawMessages.slice(0, -1).reverse()) {
      const duplicate = await receiverChat.processScopeEvent(scope, 'new_message', rawMessage)
      assert.equal(duplicate?.message?.decryptionFailed, false)
    }

    const restored = receiverChat.getMessages(channel.id)
    assert.ok(
      expected.every((text) =>
        restored.some((message) => message.content === text && !message.decryptionFailed)
      ),
      `expected ordered replay to decrypt ${JSON.stringify(expected)}, got ${JSON.stringify(
        restored.map((message) => ({ content: message.content, failed: message.decryptionFailed }))
      )}`
    )

    const newestRoomSeq = rawMessages.at(-1).room_seq
    assert.equal(typeof newestRoomSeq, 'number')
    await assert.rejects(
      receiverChat.processScopeEvent(scope, 'new_message', {
        ...rawMessages.at(-1),
        id: crypto.randomUUID(),
        room_seq: newestRoomSeq + 2
      }),
      /Could not replay room .* through sequence/,
      'a live MLS ciphertext must not consume its ratchet while a prior room sequence is unavailable'
    )
  } finally {
    owner.client.stop()
    receiver.client.stop()
  }
})

test('sdk ignores stale dm join-all replay after restart when the peer is already in the group', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const first = createClientHarness(stack.apiUrl, 'dm-stale-first')
  const second = createClientHarness(stack.apiUrl, 'dm-stale-second')
  const firstUsername = uniqueUsername('sdkdmfirst')
  const secondUsername = uniqueUsername('sdkdmsecond')
  const password = 'vesper-sdk-dm-stale-replay-password'

  try {
    await first.client.register(firstUsername, password)
    await second.client.register(secondUsername, password)
    await first.client.start(false)
    await second.client.start(false)

    const firstSession = first.client.getAuthSession()
    const secondSession = second.client.getAuthSession()
    assert.ok(firstSession, 'expected the first session to exist')
    assert.ok(secondSession, 'expected the second session to exist')

    const [leader, follower] =
      firstSession.user.id.localeCompare(secondSession.user.id) <= 0
        ? [
            {
              ...first,
              userId: firstSession.user.id
            },
            {
              ...second,
              userId: secondSession.user.id
            }
          ]
        : [
            {
              ...second,
              userId: secondSession.user.id
            },
            {
              ...first,
              userId: firstSession.user.id
            }
          ]

    const conversation = await leader.client.createConversation([follower.userId])

    await waitFor('follower conversation visibility', async () => {
      const conversations = await follower.client.listConversations()
      return conversations.find((entry) => entry.id === conversation.id) ?? null
    })

    const leaderChat = leader.client.createEncryptedChat()
    const followerChat = follower.client.createEncryptedChat()
    const scope = { kind: 'dm', id: conversation.id, channelId: conversation.channel_id }

    await leaderChat.watchScope(scope)
    await followerChat.watchScope(scope)

    assert.equal(await leaderChat.ensureScopeReady(scope, true), true)
    await leaderChat.requestJoinAll(scope)

    await waitFor('follower to join the leader DM group', async () => {
      return await followerChat.ensureMembership(scope)
    })

    const convergedEpoch = await waitFor('dm epochs to converge', async () => {
      const leaderEpoch = leaderChat.getGroupEpoch(scope.channelId || scope.id)
      const followerEpoch = followerChat.getGroupEpoch(scope.channelId || scope.id)
      return leaderEpoch != null && leaderEpoch > 0 && leaderEpoch === followerEpoch
        ? leaderEpoch
        : null
    })

    assert.equal(followerChat.isMemberOfGroup(scope.channelId || scope.id, leader.userId), true)

    follower.client.stop()

    const restartedFollower = createClientHarness(stack.apiUrl, 'dm-stale-second-restart', {
      device: follower.device,
      sessionStore: follower.sessionStore,
      storage: follower.storage
    })
    const restartedFollowerChat = restartedFollower.client.createEncryptedChat()

    try {
      await restartedFollower.client.start(false)
      await restartedFollowerChat.watchScope(scope)
      assert.equal(await restartedFollowerChat.ensureMembership(scope), true)
      const postRestartEpoch = await waitFor('restarted dm peers to converge', async () => {
        const leaderEpoch = leaderChat.getGroupEpoch(scope.channelId || scope.id)
        const followerEpoch = restartedFollowerChat.getGroupEpoch(scope.channelId || scope.id)
        return leaderEpoch != null && leaderEpoch >= convergedEpoch && leaderEpoch === followerEpoch
          ? leaderEpoch
          : null
      })
      assert.equal(restartedFollowerChat.isMemberOfGroup(scope.channelId || scope.id, leader.userId), true)
      assert.equal(restartedFollowerChat.isMemberOfGroup(scope.channelId || scope.id, follower.userId), true)

      await restartedFollowerChat.processScopeEvent(scope, 'mls_request_join_all', {
        user_id: leader.userId
      })
      assert.equal(restartedFollowerChat.getGroupEpoch(scope.channelId || scope.id), postRestartEpoch)

      await new Promise((resolve) => {
        setTimeout(resolve, 750)
      })

      assert.equal(restartedFollowerChat.hasGroup(scope.channelId || scope.id), true)
      assert.equal(restartedFollowerChat.isMemberOfGroup(scope.channelId || scope.id, leader.userId), true)
      assert.equal(restartedFollowerChat.getGroupEpoch(scope.channelId || scope.id), postRestartEpoch)
      assert.equal(leaderChat.getGroupEpoch(scope.channelId || scope.id), postRestartEpoch)
    } finally {
      restartedFollower.client.stop()
    }
  } finally {
    first.client.stop()
    second.client.stop()
  }
})

test('sdk preserves first DM messages for a peer that opens after the sender', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const first = createClientHarness(stack.apiUrl, 'dm-late-open-first')
  const second = createClientHarness(stack.apiUrl, 'dm-late-open-second')
  const firstUsername = uniqueUsername('sdklatedmfirst')
  const secondUsername = uniqueUsername('sdklatedmsecond')
  const password = 'vesper-sdk-dm-late-open-password'

  try {
    await first.client.register(firstUsername, password)
    await second.client.register(secondUsername, password)
    await first.client.start(false)
    await second.client.start(false)

    const firstSession = first.client.getAuthSession()
    const secondSession = second.client.getAuthSession()
    assert.ok(firstSession, 'expected the first session to exist')
    assert.ok(secondSession, 'expected the second session to exist')

    const [leader, follower] =
      firstSession.user.id.localeCompare(secondSession.user.id) <= 0
        ? [
            {
              ...first,
              userId: firstSession.user.id
            },
            {
              ...second,
              userId: secondSession.user.id
            }
          ]
        : [
            {
              ...second,
              userId: secondSession.user.id
            },
            {
              ...first,
              userId: firstSession.user.id
            }
          ]

    const conversation = await leader.client.createConversation([follower.userId])

    await waitFor('follower conversation visibility', async () => {
      const conversations = await follower.client.listConversations()
      return conversations.find((entry) => entry.id === conversation.id) ?? null
    })

    const leaderChat = leader.client.createEncryptedChat()
    const followerChat = follower.client.createEncryptedChat()
    const scope = { kind: 'dm', id: conversation.id, channelId: conversation.channel_id }

    await leaderChat.watchScope(scope)
    assert.equal(await leaderChat.ensureScopeReady(scope, true), true)

    // The application already authorizes the follower as a DM participant, but
    // the follower has not watched the scope yet. The sender must sponsor the
    // follower's published device package before the first message so recovery
    // does not depend on the sender remaining online. Send more rows than the
    // follower's first sync window to exercise authoritative backfill as well.
    const beforeOpenContents = Array.from({ length: 12 }, (_value, index) => `dm-before-follower-open-${index}`)
    for (const content of beforeOpenContents) {
      await leaderChat.sendText(scope, content)
    }

    const sentBeforeJoin = await waitFor('leader to retain the epoch-zero DM messages', async () => {
      const synced = await leaderChat.syncScope(scope, { limit: 20 })
      const firstMessage = synced.messages.find((message) => message.content === beforeOpenContents[0])
      return firstMessage && synced.messages.filter((message) => beforeOpenContents.includes(message.content)).length === beforeOpenContents.length ? firstMessage : null
    })
    assert.ok(sentBeforeJoin.raw.mls_epoch > 0)
    const originalPlaintext = await leader.storage.getSentMessagePlaintext(
      sentBeforeJoin.raw.ciphertext
    )
    assert.equal(
      verifyHistoryBundlePlaintext(
        originalPlaintext,
        scope.channelId || scope.id,
        sentBeforeJoin.raw
      ),
      true
    )

    await followerChat.watchScope(scope)
    await waitFor('follower to join the DM group after the message', async () => {
      return await followerChat.ensureMembership(scope)
    })
    assert.equal(
      followerChat.getGroupEpoch(scope.channelId || scope.id),
      sentBeforeJoin.raw.mls_epoch
    )

    const recovered = await waitFor('follower to recover the bounded pre-device-join DM window', async () => {
      const synced = await followerChat.syncScope(scope, { limit: 10 })
      const visible = synced.messages.filter(
        (message) => beforeOpenContents.includes(message.content) && !message.decryptionFailed
      )
      const firstCached = await follower.storage.getCachedMessageDecryption(sentBeforeJoin.id)
      const firstCachedPayload = firstCached ? JSON.parse(firstCached) : null
      return visible.length === 10 && firstCachedPayload?.text === beforeOpenContents[0]
        ? { visible, firstCached: firstCachedPayload.text }
        : null
    })

    assert.equal(recovered.visible.length, 10)
    assert.equal(recovered.firstCached, beforeOpenContents[0])
  } finally {
    first.client.stop()
    second.client.stop()
  }
})

test('sdk isolates MLS control state by assigned room cohort', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => await teardownServerStack(stack))

  const owner = createClientHarness(stack.apiUrl, 'cohort-owner')
  const peer = createClientHarness(stack.apiUrl, 'cohort-peer')
  const rotator = createClientHarness(stack.apiUrl, 'cohort-rotator')
  const other = createClientHarness(stack.apiUrl, 'cohort-other')
  const password = 'vesper-sdk-cohort-password'

  try {
    await owner.client.register(uniqueUsername('sdkcohortowner'), password)
    await peer.client.register(uniqueUsername('sdkcohortpeer'), password)
    await rotator.client.register(uniqueUsername('sdkcohortrotator'), password)
    await other.client.register(uniqueUsername('sdkcohortother'), password)
    await owner.client.start(false)
    await peer.client.start(false)
    await other.client.start(false)

    const server = await owner.client.createServer(`SDK Cohort ${Date.now()}`)
    const channel = server.channels.find((entry) => entry.name === 'general')
    assert.ok(channel)
    const invite = await owner.client.createServerInvite(server.id, {})
    await peer.client.joinServerByInvite(invite.code)
    await rotator.client.joinServerByInvite(invite.code)
    await other.client.joinServerByInvite(invite.code)

    const cutover = await owner.client.getHttpClient().apiFetch(
      `/api/v1/room-crypto-topology/${channel.id}`,
      {
        method: 'PUT',
        body: JSON.stringify({ mode: 'multi_cohort', target_cohort_size: 3 })
      }
    )
    assert.equal(cutover.status, 200)

    const ownerTopology = await owner.client.fetchRoomCryptoTopology(channel.id)
    const peerTopology = await peer.client.fetchRoomCryptoTopology(channel.id)
    const rotatorTopology = await rotator.client.fetchRoomCryptoTopology(channel.id)
    const otherTopology = await other.client.fetchRoomCryptoTopology(channel.id)
    assert.equal(ownerTopology.groupId, peerTopology.groupId)
    assert.equal(ownerTopology.groupId, rotatorTopology.groupId)
    assert.notEqual(ownerTopology.groupId, otherTopology.groupId)

    const scope = { kind: 'channel', id: channel.id }
    const ownerChat = owner.client.createEncryptedChat()
    const peerChat = peer.client.createEncryptedChat()
    const rotatorChat = rotator.client.createEncryptedChat()
    const otherChat = other.client.createEncryptedChat()
    await ownerChat.watchScope(scope)
    await peerChat.watchScope(scope)
    await otherChat.watchScope(scope)

    assert.equal(await ownerChat.ensureScopeReady(scope, true), true)
    assert.equal(await peerChat.ensureMembership(scope), true)
    assert.equal(ownerChat.hasGroup(ownerTopology.groupId), true)
    assert.equal(peerChat.hasGroup(peerTopology.groupId), true)
    assert.equal(otherChat.hasGroup(ownerTopology.groupId), false)

    assert.equal(await otherChat.ensureScopeReady(scope, true), true)
    assert.equal(otherChat.hasGroup(otherTopology.groupId), true)
    assert.equal(ownerChat.hasGroup(otherTopology.groupId), false)

    const ownerWrapping = await ownerChat.deriveScopeCohortWrappingKey(scope)
    const peerWrapping = await peerChat.deriveScopeCohortWrappingKey(scope)
    const otherWrapping = await otherChat.deriveScopeCohortWrappingKey(scope)
    assert.ok(ownerWrapping)
    assert.ok(peerWrapping)
    assert.ok(otherWrapping)
    assert.deepEqual(ownerWrapping.publication.publicKey, peerWrapping.publication.publicKey)
    assert.notDeepEqual(ownerWrapping.publication.publicKey, otherWrapping.publication.publicKey)
    assert.equal(
      await peerChat.verifyScopeCohortWrappingPublication(scope, ownerWrapping.publication),
      true
    )

    const tamperedKey = {
      ...ownerWrapping.publication,
      publicKey: new Uint8Array(ownerWrapping.publication.publicKey)
    }
    tamperedKey.publicKey[0] ^= 1
    assert.equal(await peerChat.verifyScopeCohortWrappingPublication(scope, tamperedKey), false)

    const tamperedContext = {
      ...ownerWrapping.publication,
      topologyGeneration: ownerWrapping.publication.topologyGeneration + 1
    }
    assert.equal(await peerChat.verifyScopeCohortWrappingPublication(scope, tamperedContext), false)

    const tamperedSignature = {
      ...ownerWrapping.publication,
      signature: new Uint8Array(ownerWrapping.publication.signature)
    }
    tamperedSignature.signature[0] ^= 1
    assert.equal(
      await peerChat.verifyScopeCohortWrappingPublication(scope, tamperedSignature),
      false
    )

    assert.equal(await ownerChat.publishScopeCohortWrappingKey(scope), true)
    assert.equal(await otherChat.publishScopeCohortWrappingKey(scope), true)
    const storedWrapping = await peerChat.fetchVerifiedScopeCohortWrappingKey(scope)
    assert.ok(storedWrapping)
    assert.deepEqual(storedWrapping.publicKey, ownerWrapping.publication.publicKey)

    const crossCohortWrapping = await ownerChat.fetchVerifiedCohortWrappingKey({
      roomId: otherTopology.roomId,
      cohortId: otherTopology.cohortId,
      groupId: otherTopology.groupId,
      topologyGeneration: otherTopology.generation
    })
    assert.ok(crossCohortWrapping)
    assert.deepEqual(crossCohortWrapping.publicKey, otherWrapping.publication.publicKey)

    const roomKeyRequestId = `room-key-${Date.now()}`
    const firstRoomKeyEpoch = await ownerChat.coordinateRoomKeyEpoch(
      scope,
      'initial',
      roomKeyRequestId
    )
    assert.equal(firstRoomKeyEpoch.state, 'active')
    assert.equal(firstRoomKeyEpoch.envelopes.length, 2)
    const ownerRoomKey = await ownerChat.loadActiveRoomDataKey(scope)
    const otherRoomKey = await otherChat.loadActiveRoomDataKey(scope)
    assert.ok(ownerRoomKey)
    assert.deepEqual(otherRoomKey, ownerRoomKey)

    const ownerMlsEpochBeforeApplication = ownerChat.getGroupEpoch(ownerTopology.groupId)
    const otherMlsEpochBeforeApplication = otherChat.getGroupEpoch(otherTopology.groupId)
    await Promise.race([
      ownerChat.sendText(scope, 'cross-cohort room-key message'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('cross-cohort send exceeded 5s')), 5_000))
    ])
    const crossCohortMessage = await waitFor('cross-cohort room-key message', async () => {
      const synced = await otherChat.syncScope(scope, { limit: 20 })
      return synced.messages.find(
        (message) => message.content === 'cross-cohort room-key message' && !message.decryptionFailed
      ) ?? null
    })

    await ownerChat.editText(scope, crossCohortMessage.id, 'cross-cohort edited message')
    await waitFor('cross-cohort room-key edit', async () => {
      const synced = await otherChat.syncScope(scope, { limit: 20 })
      return synced.messages.some((message) => message.content === 'cross-cohort edited message')
    })

    await ownerChat.addReaction(scope, crossCohortMessage.id, 'room-key-reaction')
    await waitFor('cross-cohort room-key reaction', async () => {
      const synced = await otherChat.syncScope(scope, { limit: 20 })
      const message = synced.messages.find((entry) => entry.id === crossCohortMessage.id)
      return message?.raw.reactions?.some((reaction) => reaction.emoji === 'room-key-reaction')
    })
    assert.equal(ownerChat.getGroupEpoch(ownerTopology.groupId), ownerMlsEpochBeforeApplication)
    assert.equal(otherChat.getGroupEpoch(otherTopology.groupId), otherMlsEpochBeforeApplication)

    const resumedAfterAckLoss = await ownerChat.coordinateRoomKeyEpoch(
      scope,
      'initial',
      roomKeyRequestId
    )
    assert.equal(resumedAfterAckLoss.id, firstRoomKeyEpoch.id)
    assert.deepEqual(await ownerChat.loadActiveRoomDataKey(scope), ownerRoomKey)

    const substitutedKey = new Uint8Array(ownerWrapping.publication.publicKey)
    substitutedKey[0] ^= 1
    const substitution = await owner.client.getHttpClient().apiFetch(
      `/api/v1/cohort-wrapping-keys/${ownerTopology.groupId}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          mls_epoch: ownerWrapping.publication.mlsEpoch,
          public_key: Buffer.from(substitutedKey).toString('base64'),
          signature: Buffer.from(ownerWrapping.publication.signature).toString('base64'),
          signer_identity: ownerWrapping.publication.signerIdentity,
          signer_public_key: Buffer.from(ownerWrapping.publication.signerPublicKey).toString('base64'),
          group_info_digest: Buffer.from(ownerWrapping.publication.groupInfoDigest).toString('base64')
        })
      }
    )
    assert.equal(substitution.status, 409)

    const otherCohortEpochBeforeRotation = otherChat.getGroupEpoch(otherTopology.groupId)
    await rotator.client.start(false)
    await rotatorChat.watchScope(scope)
    assert.equal(await rotatorChat.ensureMembership(scope), true)
    const rotatorJoinedEpoch = rotatorChat.getGroupEpoch(rotatorTopology.groupId)
    assert.ok(
      rotatorJoinedEpoch != null && rotatorJoinedEpoch > ownerWrapping.publication.mlsEpoch,
      `expected rotator to join after wrapping epoch ${ownerWrapping.publication.mlsEpoch}; rotator=${rotatorJoinedEpoch}; owner=${ownerChat.getGroupEpoch(ownerTopology.groupId)}`
    )
    await waitFor('cohort wrapping epoch rotation', async () => {
      return ownerChat.getGroupEpoch(ownerTopology.groupId) === rotatorJoinedEpoch
    })

    const rotatedWrapping = await ownerChat.deriveScopeCohortWrappingKey(scope)
    assert.ok(rotatedWrapping)
    assert.ok(rotatedWrapping.publication.mlsEpoch > ownerWrapping.publication.mlsEpoch)
    assert.notDeepEqual(rotatedWrapping.publication.publicKey, ownerWrapping.publication.publicKey)
    assert.equal(
      await ownerChat.verifyScopeCohortWrappingPublication(scope, ownerWrapping.publication),
      false
    )
    assert.equal(await ownerChat.publishScopeCohortWrappingKey(scope), true)

    await ownerChat.sendText(scope, 'automatic room-key rotation')
    await waitFor('automatic room-key rotation delivery', async () => {
      const synced = await otherChat.syncScope(scope, { limit: 20 })
      return synced.messages.some(
        (message) => message.content === 'automatic room-key rotation' && !message.decryptionFailed
      )
    })

    const rotatedEpochResponse = await owner.client.getHttpClient().apiFetch(
      `/api/v1/room-key-epochs/${channel.id}/active`
    )
    assert.equal(rotatedEpochResponse.status, 200)
    const { room_key_epoch: rotatedRoomKeyEpoch } = await rotatedEpochResponse.json()
    assert.equal(rotatedRoomKeyEpoch.state, 'active')
    assert.equal(rotatedRoomKeyEpoch.epoch, firstRoomKeyEpoch.epoch + 1)
    assert.equal(otherChat.getGroupEpoch(otherTopology.groupId), otherCohortEpochBeforeRotation)
    const rotatedOwnerRoomKey = await ownerChat.loadActiveRoomDataKey(scope)
    const rotatedOtherRoomKey = await otherChat.loadActiveRoomDataKey(scope)
    assert.ok(rotatedOwnerRoomKey)
    assert.deepEqual(rotatedOtherRoomKey, rotatedOwnerRoomKey)
  } finally {
    owner.client.stop()
    peer.client.stop()
    rotator.client.stop()
    other.client.stop()
  }
})

test('sdk migrates a populated room through one durable cutover without losing mixed history', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => await teardownServerStack(stack))

  const harnesses = [
    createClientHarness(stack.apiUrl, 'migration-owner'),
    createClientHarness(stack.apiUrl, 'migration-peer'),
    createClientHarness(stack.apiUrl, 'migration-other')
  ]
  const password = 'vesper-sdk-migration-password'

  try {
    for (const [index, harness] of harnesses.entries()) {
      await harness.client.register(uniqueUsername(`sdkmigration${index}`), password)
      await harness.client.start(false)
    }

    const [owner, peer, other] = harnesses
    const server = await owner.client.createServer(`SDK Migration ${Date.now()}`)
    const channel = server.channels.find((entry) => entry.name === 'general')
    assert.ok(channel)
    const invite = await owner.client.createServerInvite(server.id, {})
    await peer.client.joinServerByInvite(invite.code)
    await other.client.joinServerByInvite(invite.code)

    const scope = { kind: 'channel', id: channel.id }
    const chats = harnesses.map((harness) => harness.client.createEncryptedChat())
    for (const chat of chats) {
      await chat.watchScope(scope)
    }
    await waitFor('legacy owner group readiness', async () =>
      await chats[0].ensureScopeReady(scope, true)
    )

    for (let index = 1; index < chats.length; index += 1) {
      await waitFor(`legacy member ${index} join`, async () => await chats[index].ensureMembership(scope))
    }

    await chats[0].sendText(scope, 'legacy-before-topology-cutover')
    for (let index = 1; index < chats.length; index += 1) {
      await waitFor(`legacy visibility ${index}`, async () => {
        const synced = await chats[index].syncScope(scope, { limit: 20 })
        return synced.messages.some(
          (message) => message.content === 'legacy-before-topology-cutover' && !message.decryptionFailed
        )
      })
    }

    const prepareResponse = await owner.client.getHttpClient().apiFetch(
      `/api/v1/room-crypto-topology/${channel.id}/prepare`,
      {
        method: 'POST',
        body: JSON.stringify({
          mode: 'multi_cohort',
          target_cohort_size: 2,
          request_id: `migration-${Date.now()}`
        })
      }
    )
    assert.equal(prepareResponse.status, 200)
    const { migration } = await prepareResponse.json()
    assert.equal(migration.state, 'cohorts_ready')

    const preparedTopologies = await Promise.all(
      harnesses.map((harness) => harness.client.fetchRoomCryptoTopology(channel.id, migration.id))
    )
    assert.equal(new Set(preparedTopologies.map((topology) => topology.groupId)).size, 2)

    const entries = harnesses.map((harness, index) => ({
      harness,
      chat: chats[index],
      topology: preparedTopologies[index]
    }))
    const cohorts = Map.groupBy(entries, (entry) => entry.topology.groupId)

    for (const members of cohorts.values()) {
      assert.equal(await members[0].chat.prepareCohortTopology(members[0].topology, true), true)
      for (const member of members.slice(1)) {
        await waitFor(`prepared cohort join ${member.topology.groupId}`, async () =>
          await member.chat.prepareCohortTopology(member.topology, false)
        )
      }
    }

    const staged = await chats[0].coordinatePreparedRoomKeyEpoch(
      scope,
      preparedTopologies[0],
      `migration-key-${Date.now()}`
    )
    assert.equal(staged.state, 'staged')

    const cutoverResponse = await owner.client.getHttpClient().apiFetch(
      `/api/v1/room-crypto-topology/${channel.id}/cutover`,
      {
        method: 'POST',
        body: JSON.stringify({ topology_id: migration.id })
      }
    )
    assert.equal(cutoverResponse.status, 200)
    const { topology: activeTopology } = await cutoverResponse.json()
    assert.equal(activeTopology.generation, migration.generation)
    assert.equal(activeTopology.state, 'active')

    const senderIndex = 0
    const receiverIndex = preparedTopologies.findIndex(
      (topology) => topology.groupId !== preparedTopologies[senderIndex].groupId
    )
    assert.ok(receiverIndex > 0)

    await chats[senderIndex].sendText(scope, 'room-key-after-topology-cutover')

    const mixed = await waitFor('mixed migration history', async () => {
      const synced = await chats[receiverIndex].syncScope(scope, { limit: 20 })
      const legacy = synced.messages.find(
        (message) => message.content === 'legacy-before-topology-cutover'
      )
      const current = synced.messages.find(
        (message) => message.content === 'room-key-after-topology-cutover'
      )
      return legacy && current && !legacy.decryptionFailed && !current.decryptionFailed
        ? { legacy, current }
        : null
    })

    assert.equal(mixed.legacy.raw.encryption_scheme, 'mls')
    assert.ok(mixed.legacy.raw.encryption_group_id)
    assert.equal(mixed.current.raw.encryption_scheme, 'vesper-room-v1')
    assert.equal(mixed.current.raw.encryption_group_id, null)
    assert.ok(mixed.legacy.raw.room_seq < activeTopology.cutover_room_seq)
    assert.ok(mixed.current.raw.room_seq > activeTopology.cutover_room_seq)

    const receiver = harnesses[receiverIndex]
    const receiverGroupId = preparedTopologies[receiverIndex].groupId
    const logicalRoomId = scope.channelId || scope.id
    const [groupCheckpointBeforeRestart, roomCheckpointBeforeRestart] = await Promise.all([receiver.storage.getScopeCheckpoint(receiverGroupId), receiver.storage.getScopeCheckpoint(logicalRoomId)])
    assert.equal(groupCheckpointBeforeRestart.room_data_keys.length, 0)
    assert.equal(roomCheckpointBeforeRestart.room_data_keys.length, 1)

    receiver.client.stop()
    const restartedReceiver = createClientHarness(stack.apiUrl, 'migration-restarted-receiver', {
      device: receiver.device,
      sessionStore: receiver.sessionStore,
      storage: receiver.storage
    })
    const restartedChat = restartedReceiver.client.createEncryptedChat()

    try {
      await restartedReceiver.client.start(false)
      await restartedChat.watchScope(scope)

      const afterRestart = await waitFor('room-key history after restart', async () => {
        const synced = await restartedChat.syncScope(scope, { limit: 20 })
        const current = synced.messages.find((message) => message.content === 'room-key-after-topology-cutover')
        return current && !current.decryptionFailed ? current : null
      })

      assert.equal(afterRestart.raw.encryption_scheme, 'vesper-room-v1')
    } finally {
      restartedReceiver.client.stop()
    }
  } finally {
    for (const harness of harnesses) {
      harness.client.stop()
    }
  }
})

test('sdk restores bounded DM history from an account-owned package after every prior device disconnects', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  let recoveryPackagePutCount = 0
  const countingFetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (init?.method === 'PUT' && url.includes('/api/v1/scope-recovery-packages/')) {
      recoveryPackagePutCount += 1
    }
    return await fetch(input, init)
  }
  const alicePrimary = createClientHarness(stack.apiUrl, 'package-alice-primary', {
    fetchImpl: countingFetch
  })
  const aliceRecovery = createClientHarness(stack.apiUrl, 'package-alice-recovery')
  const bob = createClientHarness(stack.apiUrl, 'package-bob')
  const aliceUsername = uniqueUsername('sdkpackagealice')
  const bobUsername = uniqueUsername('sdkpackagebob')
  const password = 'vesper-sdk-package-password'

  try {
    const registeredAlice = await alicePrimary.client.register(aliceUsername, password)
    assert.ok(registeredAlice.recoveryMnemonic, 'expected an account recovery mnemonic')
    await bob.client.register(bobUsername, password)
    await alicePrimary.client.start(false)
    await bob.client.start(false)

    const bobSession = bob.client.getAuthSession()
    assert.ok(bobSession, 'expected the bob session to exist')
    const conversation = await alicePrimary.client.createConversation([bobSession.user.id])

    await waitFor('bob package DM visibility', async () => {
      const conversations = await bob.client.listConversations()
      return conversations.find((entry) => entry.id === conversation.id) ?? null
    })

    const scope = { kind: 'dm', id: conversation.id, channelId: conversation.channel_id }
    const aliceChat = alicePrimary.client.createEncryptedChat()
    const bobChat = bob.client.createEncryptedChat()
    await aliceChat.watchScope(scope)
    await bobChat.watchScope(scope)
    assert.equal(await aliceChat.ensureScopeReady(scope, true), true)
    await waitFor('bob to join package DM', async () => await bobChat.ensureMembership(scope))

    const expected = ['package-history-one', 'package-history-two', 'package-history-three']
    for (const text of expected) {
      await aliceChat.sendText(scope, text)
      await waitFor(`bob to decrypt ${text}`, async () => {
        const synced = await bobChat.syncScope(scope, { limit: 20 })
        return synced.messages.some((message) => message.content === text && !message.decryptionFailed)
      })
    }

    const primaryWindow = await aliceChat.syncScope(scope, { limit: 20 })
    assert.ok(
      expected.every((text) =>
        primaryWindow.messages.some(
          (message) => message.content === text && !message.decryptionFailed
        )
      ),
      'primary device must persist the complete decryptable hot window before disconnect'
    )
    assert.ok(
      await alicePrimary.storage.getRecoveryPackageKey(registeredAlice.user.id),
      'registration must persist an account recovery package key'
    )
    const primaryCachedRecords = await alicePrimary.storage.getCachedMessages(
      conversation.channel_id
    )
    assert.equal(primaryCachedRecords.length, expected.length)

    let initialRecoveryPackageCiphertext = null
    await waitFor('opaque recovery package persistence', async () => {
      const response = await alicePrimary.client
        .getHttpClient()
        .apiFetch(`/api/v1/scope-recovery-packages/${conversation.channel_id}`)
      if (!response.ok) return false
      const body = await response.json()
      initialRecoveryPackageCiphertext = body.package?.ciphertext ?? null
      return initialRecoveryPackageCiphertext != null
    })

    await waitFor(
      'recovery package publisher to become idle',
      async () => aliceChat.recoveryPackagePublishes.size === 0,
      5_000
    )
    assert.ok(recoveryPackagePutCount > 0, 'expected the primary client to publish its initial package')
    recoveryPackagePutCount = 0
    const recoveryPublishScope = aliceChat.hasGroup(scope.id)
      ? scope
      : { ...scope, id: conversation.channel_id }
    assert.equal(aliceChat.hasGroup(recoveryPublishScope.id), true)
    assert.equal(aliceChat.hasGroup(aliceChat.resolveMlsGroupId(recoveryPublishScope)), true)
    const publishRequests = Array.from(
      { length: 20 },
      () => aliceChat.publishScopeRecoveryPackage(recoveryPublishScope)
    )
    assert.equal(aliceChat.recoveryPackagePublishes.size, 1)
    await Promise.all(publishRequests)
    assert.equal(
      recoveryPackagePutCount,
      1,
      `concurrent recovery-package requests must coalesce into exactly one fresh snapshot upload; got ${recoveryPackagePutCount}`
    )
    const refreshedPackageResponse = await alicePrimary.client
      .getHttpClient()
      .apiFetch(`/api/v1/scope-recovery-packages/${conversation.channel_id}`)
    assert.equal(refreshedPackageResponse.ok, true)
    const refreshedPackage = await refreshedPackageResponse.json()
    assert.notEqual(
      refreshedPackage.package?.ciphertext,
      initialRecoveryPackageCiphertext,
      'the coalesced publish must replace the durable encrypted package'
    )

    alicePrimary.client.stop()
    bob.client.stop()

    const pending = await aliceRecovery.client.login(aliceUsername, password)
    assert.equal(pending.currentDevice?.trust_state, 'pending')
    const approved = await aliceRecovery.client.approveCurrentDeviceWithRecovery(
      registeredAlice.recoveryMnemonic
    )
    assert.equal(approved.canUseE2EE, true)
    await aliceRecovery.client.start(false)

    const placeholder = primaryCachedRecords[0]
    await aliceRecovery.storage.cacheMessage({
      ...placeholder,
      decrypted_content: null
    })

    const recoveryChat = aliceRecovery.client.createEncryptedChat()
    await recoveryChat.watchScope(scope)
    assert.equal(await recoveryChat.ensureMembership(scope), true)

    const restored = await recoveryChat.syncScope(scope, { limit: 20 })
    for (const text of expected) {
      assert.ok(
        restored.messages.some(
          (message) => message.content === text && message.decryptionFailed === false
        ),
        `expected account package restore to include ${text}`
      )
    }

    const primaryIdentity = await alicePrimary.storage.getIdentityKeys(
      alicePrimary.client.getAuthSession().user.id
    )
    const recoveryIdentity = await aliceRecovery.storage.getIdentityKeys(
      aliceRecovery.client.getAuthSession().user.id
    )
    assert.notDeepEqual(
      new Uint8Array(primaryIdentity.signature_private_key),
      new Uint8Array(recoveryIdentity.signature_private_key),
      'device MLS identities must remain distinct'
    )
    assert.deepEqual(
      new Uint8Array(await alicePrimary.storage.getRecoveryPackageKey(registeredAlice.user.id)),
      new Uint8Array(await aliceRecovery.storage.getRecoveryPackageKey(registeredAlice.user.id)),
      'trusted devices must derive the same account recovery package key'
    )
  } finally {
    alicePrimary.client.stop()
    aliceRecovery.client.stop()
    bob.client.stop()
  }
})

test('sdk handles same-user history repair without renderer protocol help', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const primary = createClientHarness(stack.apiUrl, 'history-primary')
  const secondary = createClientHarness(stack.apiUrl, 'history-secondary')
  const username = uniqueUsername('sdkhistory')
  const password = 'vesper-sdk-history-password'

  try {
    await primary.client.register(username, password)
    await primary.client.start(false)

    await approveAndUnlockSecondary(
      primary.client,
      secondary.client,
      secondary.device.id,
      username,
      password
    )
    await secondary.client.start(false)

    const primaryChat = primary.client.createEncryptedChat()
    const secondaryChat = secondary.client.createEncryptedChat()
    const channel = await createGeneralChannel(primary.client, `SDK History ${Date.now()}`)
    const scope = { kind: 'channel', id: channel.id }

    await primaryChat.watchScope(scope)
    await secondaryChat.watchScope(scope)
    assert.equal(await primaryChat.ensureScopeReady(scope, true), true)

    await primaryChat.sendText(scope, 'history-before-secondary')

    await waitFor('primary latest message is visible', async () => {
      const synced = await primaryChat.syncScope(scope, { limit: 10 })
      return synced.messages.some((message) => message.content === 'history-before-secondary')
    })

    assert.equal(await secondaryChat.ensureMembership(scope), true)

    const recovered = await waitFor('secondary history repair to recover previous message', async () => {
      const synced = await secondaryChat.syncScope(scope, { limit: 20 })
      return synced.messages.find((message) => message.content === 'history-before-secondary') ?? null
    })

    assert.equal(recovered.decryptionFailed, false)
    await waitFor('journaled history controls to complete', async () => {
      const [requests, bundles] = await Promise.all([
        loadControlIntents(secondary.storage, channel.id, 'mls_history_request'),
        loadControlIntents(primary.storage, channel.id, 'mls_history_bundle')
      ])
      return requests.length === 0 && bundles.length === 0
    })
  } finally {
    primary.client.stop()
    secondary.client.stop()
  }
})

test('sdk same-user DM history repair stays scope-bounded for multiple pre-join messages', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const alicePrimary = createClientHarness(stack.apiUrl, 'dm-history-primary')
  const aliceSecondary = createClientHarness(stack.apiUrl, 'dm-history-secondary')
  const bob = createClientHarness(stack.apiUrl, 'dm-history-bob')
  const aliceUsername = uniqueUsername('sdkdmhistoryalice')
  const bobUsername = uniqueUsername('sdkdmhistorybob')
  const password = 'vesper-sdk-dm-history-password'

  try {
    await alicePrimary.client.register(aliceUsername, password)
    await bob.client.register(bobUsername, password)
    await alicePrimary.client.start(false)
    await bob.client.start(false)

    const bobSession = bob.client.getAuthSession()
    assert.ok(bobSession, 'expected the bob session to exist')

    await approveAndUnlockSecondary(
      alicePrimary.client,
      aliceSecondary.client,
      aliceSecondary.device.id,
      aliceUsername,
      password
    )
    await aliceSecondary.client.start(false)

    const alicePrimaryChat = alicePrimary.client.createEncryptedChat()
    const aliceSecondaryChat = aliceSecondary.client.createEncryptedChat()
    const bobChat = bob.client.createEncryptedChat()

    const conversation = await alicePrimary.client.createConversation([bobSession.user.id])

    await waitFor('bob DM visibility', async () => {
      const conversations = await bob.client.listConversations()
      return conversations.find((entry) => entry.id === conversation.id) ?? null
    })

    await waitFor('secondary alice DM visibility', async () => {
      const conversations = await aliceSecondary.client.listConversations()
      return conversations.find((entry) => entry.id === conversation.id) ?? null
    })

    const scope = { kind: 'dm', id: conversation.id, channelId: conversation.channel_id }

    await alicePrimaryChat.watchScope(scope)
    await bobChat.watchScope(scope)
    assert.equal(await alicePrimaryChat.ensureScopeReady(scope, true), true)

    await waitFor('bob to join the DM group', async () => {
      return await bobChat.ensureMembership(scope)
    })

    const preJoinMessages = [
      'dm-history-one',
      'dm-history-two',
      'dm-history-three',
      'dm-history-four',
      'dm-history-five'
    ]

    for (const text of preJoinMessages) {
      await alicePrimaryChat.sendText(scope, text)
    }

    await aliceSecondaryChat.watchScope(scope)
    assert.equal(await aliceSecondaryChat.ensureMembership(scope), true)

    const firstSyncStartedAt = performance.now()
    await aliceSecondaryChat.syncScope(scope, { limit: 50 })
    const firstSyncDurationMs = performance.now() - firstSyncStartedAt

    assert.ok(
      firstSyncDurationMs < 8_000,
      `expected first DM sync to stay bounded, got ${firstSyncDurationMs.toFixed(2)}ms`
    )

    const recovered = await waitFor(
      'secondary alice to recover all pre-join DM messages',
      async () => {
        const synced = await aliceSecondaryChat.syncScope(scope, { limit: 50 })
        const recoveredAll = preJoinMessages.every((text) =>
          synced.messages.some(
            (message) => message.content === text && message.decryptionFailed === false
          )
        )
        return recoveredAll ? synced : null
      },
      10_000,
      100
    )

    for (const text of preJoinMessages) {
      assert.ok(
        recovered.messages.some(
          (message) => message.content === text && message.decryptionFailed === false
        ),
        `expected recovered DM messages to include ${text}`
      )
    }
  } finally {
    alicePrimary.client.stop()
    aliceSecondary.client.stop()
    bob.client.stop()
  }
})

test('sdk client keeps server state in sync for channel CRUD and clears scope state on server removal', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const { client } = createClientHarness(stack.apiUrl, 'server-state')
  const username = uniqueUsername('sdksrv')
  const password = 'vesper-sdk-server-state-password'

  try {
    await client.register(username, password)
    await client.start(false)

    const chat = client.createEncryptedChat()
    const server = await client.createServer(`SDK Server State ${Date.now()}`)
    const general = server.channels.find((channel) => channel.name === 'general') ?? null
    assert.ok(general, 'expected the default general channel')
    assert.equal(client.getState().unreadCounts.channels[general.id], 0)

    const scope = { kind: 'channel', id: general.id }
    await chat.watchScope(scope)
    assert.equal(await chat.ensureScopeReady(scope, true), true)
    assert.equal(chat.hasGroup(general.id), true)

    const archive = await client.createServerChannel(server.id, {
      name: 'archive',
      type: 'text'
    })
    assert.ok(
      client.getState().servers
        .find((entry) => entry.id === server.id)
        ?.channels.some((channel) => channel.id === archive.id)
    )
    assert.equal(client.getState().unreadCounts.channels[archive.id], 0)

    await client.updateServerChannel(server.id, archive.id, {
      name: 'notes',
      type: archive.type
    })
    assert.equal(
      client.getState().servers
        .find((entry) => entry.id === server.id)
        ?.channels.find((channel) => channel.id === archive.id)
        ?.name,
      'notes'
    )

    await client.deleteServerChannel(server.id, archive.id)
    assert.equal(
      client.getState().servers
        .find((entry) => entry.id === server.id)
        ?.channels.some((channel) => channel.id === archive.id),
      false
    )

    await client.deleteServer(server.id)
    assert.equal(client.getState().servers.some((entry) => entry.id === server.id), false)
    assert.equal(chat.hasGroup(general.id), false)
  } finally {
    client.stop()
  }
})

test('sdk client instances keep auth and realtime transport isolated', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const { client: alpha } = createClientHarness(stack.apiUrl, 'isolated-alpha')
  const { client: beta } = createClientHarness(stack.apiUrl, 'isolated-beta')
  const alphaUsername = uniqueUsername('sdkalpha')
  const betaUsername = uniqueUsername('sdkbeta')
  const password = 'vesper-sdk-isolated-password'

  try {
    await alpha.register(alphaUsername, password)
    await beta.register(betaUsername, password)

    await alpha.start(false)
    await beta.start(false)

    const [alphaMe, betaMe] = await Promise.all([
      alpha.fetchCurrentUser(),
      beta.fetchCurrentUser()
    ])

    assert.equal(alphaMe.username, alphaUsername)
    assert.equal(betaMe.username, betaUsername)
    assert.notEqual(alphaMe.id, betaMe.id)

    const alphaServer = await alpha.createServer(`Alpha ${Date.now()}`)
    const betaServer = await beta.createServer(`Beta ${Date.now()}`)

    assert.ok(alpha.getState().servers.some((server) => server.id === alphaServer.id))
    assert.ok(beta.getState().servers.some((server) => server.id === betaServer.id))

    alpha.stop()

    const betaState = await beta.syncNow(false)
    assert.equal(betaState.user?.username, betaUsername)

    const betaReloaded = await beta.fetchCurrentUser()
    assert.equal(betaReloaded.username, betaUsername)
  } finally {
    alpha.stop()
    beta.stop()
  }
})
