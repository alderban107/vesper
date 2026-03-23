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

test('sdk flushes a persisted external commit broadcast after restart', { concurrency: false }, async (t) => {
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
    let droppedCommit = false

    joinerChat.pushMlsControlEvent = async (scopeId, event, payload, topic = null) => {
      if (!droppedCommit && scopeId === channel.id && event === 'mls_commit') {
        droppedCommit = true
        return false
      }

      return await originalPushMlsControlEvent(scopeId, event, payload, topic)
    }

    try {
      const joined = await joinerChat.ensureMembership(scope)
      assert.equal(joined, true)
      assert.equal(droppedCommit, true)

      const pendingBroadcasts = await joinerShared.storage.getPendingExternalCommitBroadcasts()
      assert.equal(pendingBroadcasts.length, 1)
      assert.equal(pendingBroadcasts[0]?.group_id, channel.id)
      assert.equal(ownerChat.getGroupEpoch(channel.id), 0)
    } finally {
      joinerChat.pushMlsControlEvent = originalPushMlsControlEvent
    }

    joinerShared.client.stop()

    const restartedJoiner = createClientHarness(stack.apiUrl, 'external-joiner-restart', {
      device: joinerShared.device,
      sessionStore: joinerShared.sessionStore,
      storage: joinerShared.storage
    })
    const restartedChat = restartedJoiner.client.createEncryptedChat()

    try {
      await restartedJoiner.client.start(false)
      assert.equal(await restartedChat.ensureMembership(scope), true)

      await waitFor('owner to apply the replayed external commit', async () => {
        return ownerChat.getGroupEpoch(channel.id) === 1
      })

      await waitFor('pending external commit broadcast to clear after restart', async () => {
        const pendingBroadcasts = await joinerShared.storage.getPendingExternalCommitBroadcasts()
        return pendingBroadcasts.length === 0
      })

      assert.equal(restartedChat.getGroupEpoch(channel.id), 1)
    } finally {
      restartedJoiner.client.stop()
    }
  } finally {
    owner.client.stop()
    joinerShared.client.stop()
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
