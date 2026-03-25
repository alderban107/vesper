import assert from 'node:assert/strict'
import test from 'node:test'

import { createVesperClient } from '../dist/index.js'
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

      const pendingPublishes = await shared.storage.getPendingGroupInfoPublishes()
      assert.equal(pendingPublishes.length, 1)
      assert.equal(pendingPublishes[0]?.group_id, channel.id)
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
        const pendingPublishes = await shared.storage.getPendingGroupInfoPublishes()
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
    await secondaryChat.watchScope(scope)
    assert.equal(await primaryChat.createScopeGroup(scope), true)
    assert.equal(primaryChat.getGroupEpoch(channel.id), 0)

    const httpClient = primaryShared.client.getHttpClient()
    const originalApiFetch = httpClient.apiFetch.bind(httpClient)
    const sponsoredPath = `/api/v1/mls-sponsored-transition/${encodeURIComponent(channel.id)}`
    let failedOnce = false

    httpClient.apiFetch = async (path, options = {}) => {
      if (!failedOnce && path === sponsoredPath && options.method === 'POST') {
        failedOnce = true
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

      const pending = await primaryShared.storage.getPendingSponsoredTransitions()
      assert.equal(pending.length, 1)
      assert.equal(pending[0]?.group_id, channel.id)

      assert.equal(primaryChat.getGroupEpoch(channel.id), 1)
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
        const pending = await primaryShared.storage.getPendingSponsoredTransitions()
        return pending.length === 0
      })

      await waitFor('secondary device to receive the sponsored resync', async () => {
        return await secondaryChat.ensureMembership(scope)
      })

      await waitFor('post-transition GroupInfo publish to flush', async () => {
        const pending = await primaryShared.storage.getPendingGroupInfoPublishes()
        return pending.length === 0
      })

      assert.equal(secondaryChat.getGroupEpoch(channel.id), 1)
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
  const secondaryOwner = createClientHarness(stack.apiUrl, 'sponsor-race-secondary')
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
    await secondaryOwner.client.start(false)

    const ownerChat = owner.client.createEncryptedChat()
    const friendChat = friend.client.createEncryptedChat()
    const secondaryOwnerChat = secondaryOwner.client.createEncryptedChat()

    const server = await owner.client.createServer(`SDK Sponsored Race ${Date.now()}`)
    const channel = server.channels.find((entry) => entry.name === 'general') ?? null
    assert.ok(channel, 'expected the default general channel')
    const invite = await owner.client.createServerInvite(server.id, {})
    await friend.client.joinServerByInvite(invite.code)

    const scope = { kind: 'channel', id: channel.id }
    await ownerChat.watchScope(scope)
    await friendChat.watchScope(scope)
    await secondaryOwnerChat.watchScope(scope)

    assert.equal(await ownerChat.createScopeGroup(scope), true)
    assert.equal(await friendChat.ensureMembership(scope), true)

    await waitFor('owner and friend to share epoch 1', async () => {
      return ownerChat.getGroupEpoch(channel.id) === 1 && friendChat.getGroupEpoch(channel.id) === 1
    })

    const ownerSession = owner.client.getAuthSession()
    assert.ok(ownerSession, 'expected an owner auth session')

    const sponsoredPath = `/api/v1/mls-sponsored-transition/${encodeURIComponent(channel.id)}`
    const ownerHttp = owner.client.getHttpClient()
    const friendHttp = friend.client.getHttpClient()
    const originalOwnerApiFetch = ownerHttp.apiFetch.bind(ownerHttp)
    const originalFriendApiFetch = friendHttp.apiFetch.bind(friendHttp)
    let readyCount = 0
    let releaseBarrier = null
    const barrier = new Promise((resolve) => {
      releaseBarrier = resolve
      setTimeout(resolve, 1_000)
    })

    ownerHttp.apiFetch = async (path, options = {}) => {
      if (path === sponsoredPath && options.method === 'POST') {
        readyCount += 1
        if (readyCount === 2) {
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
          releaseBarrier?.()
        }
        await barrier
      }

      return await originalFriendApiFetch(path, options)
    }

    try {
      const [ownerSponsored, friendSponsored] = await Promise.all([
        ownerChat.sponsorScopeResync(channel.id, ownerSession.user.id, secondaryOwner.device.id),
        friendChat.sponsorScopeResync(channel.id, ownerSession.user.id, secondaryOwner.device.id)
      ])

      assert.equal(
        [ownerSponsored, friendSponsored].filter(Boolean).length,
        1,
        'expected exactly one sponsor to win the CAS'
      )

      await waitFor('both sponsors to converge on epoch 2', async () => {
        return ownerChat.getGroupEpoch(channel.id) === 2 && friendChat.getGroupEpoch(channel.id) === 2
      })

      await waitFor('secondary owner device to rejoin from the winning sponsorship', async () => {
        return await secondaryOwnerChat.ensureMembership(scope)
      })

      assert.equal((await owner.storage.getPendingSponsoredTransitions()).length, 0)
      assert.equal((await friend.storage.getPendingSponsoredTransitions()).length, 0)
      assert.equal(ownerChat.hasGroup(channel.id), true)
      assert.equal(friendChat.hasGroup(channel.id), true)
    } finally {
      ownerHttp.apiFetch = originalOwnerApiFetch
      friendHttp.apiFetch = originalFriendApiFetch
    }
  } finally {
    owner.client.stop()
    friend.client.stop()
    secondaryOwner.client.stop()
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

      const pendingBroadcasts = await joinerShared.storage.getPendingExternalCommitBroadcasts()
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

test('sdk advances durable replay after restart when a live commit was already applied', { concurrency: false }, async (t) => {
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

    assert.equal(await ownerShared.storage.getGroupSyncCursor(channel.id), 0)

    const checkpointBeforeRestart = await ownerShared.storage.getScopeCheckpoint(channel.id)
    assert.ok(
      checkpointBeforeRestart.recent_commit_fingerprints.length > 0,
      'expected a persisted recent commit fingerprint before restart'
    )

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

      await waitFor('replay cursor to advance after restart', async () => {
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

    await waitFor('dm epochs to converge', async () => {
      return leaderChat.getGroupEpoch(scope.channelId || scope.id) === 1 && followerChat.getGroupEpoch(scope.channelId || scope.id) === 1
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
      assert.equal(restartedFollowerChat.getGroupEpoch(scope.channelId || scope.id), 1)
      assert.equal(restartedFollowerChat.isMemberOfGroup(scope.channelId || scope.id, leader.userId), true)

      await restartedFollowerChat.processScopeEvent(scope, 'mls_request_join_all', {
        user_id: leader.userId
      })

      await new Promise((resolve) => {
        setTimeout(resolve, 750)
      })

      assert.equal(restartedFollowerChat.hasGroup(scope.channelId || scope.id), true)
      assert.equal(restartedFollowerChat.isMemberOfGroup(scope.channelId || scope.id, leader.userId), true)
      assert.equal(restartedFollowerChat.getGroupEpoch(scope.channelId || scope.id), 1)
      assert.equal(leaderChat.getGroupEpoch(scope.channelId || scope.id), 1)
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

    // Follower joins the group via External Commit before any messages
    await followerChat.watchScope(scope)
    await waitFor('follower to join the DM group', async () => {
      return await followerChat.ensureMembership(scope)
    })

    // Now send the message — both are in the group, follower can decrypt
    await leaderChat.sendText(scope, 'dm-before-follower-open')

    const recovered = await waitFor('follower to decrypt the DM message', async () => {
      const synced = await followerChat.syncScope(scope, { limit: 10 })
      return synced.messages.find(
        (message) => message.content === 'dm-before-follower-open' && !message.decryptionFailed
      ) ?? null
    })

    assert.equal(recovered.decryptionFailed, false)
  } finally {
    first.client.stop()
    second.client.stop()
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
