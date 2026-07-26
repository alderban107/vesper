import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  MemoryStorage,
  createCryptoStorageRuntime
} from '../dist/storage/index.js'
import { FileCryptoStorage } from '../dist/storage/file.js'
import {
  InjectedDroppedAckError,
  injectDroppedAck,
  injectDuplicateDelivery,
  injectReorderedReplayPage,
  injectRestart
} from '../dist/testing/index.js'

function configureMemoryStorage() {
  const storage = new MemoryStorage()
  const runtime = createCryptoStorageRuntime(storage)
  runtime.init(`storage-hotpaths-${Date.now()}-${Math.random()}`)
  return { runtime, storage }
}

test('key package refs support direct lookup without scanning the whole set', async (t) => {
  const { runtime } = configureMemoryStorage()
  t.after(() => {
    runtime.reset()
  })

  await runtime.saveKeyPackages([
    {
      publicData: Uint8Array.from([1, 2, 3]),
      privateData: Uint8Array.from([4, 5, 6])
    },
    {
      publicData: Uint8Array.from([7, 8, 9]),
      privateData: Uint8Array.from([10, 11, 12])
    }
  ])

  const packages = await runtime.loadKeyPackages()
  assert.equal(packages.length, 2)
  assert.ok(packages[1].keyPackageRef)

  const directMatch = await runtime.loadKeyPackageByRef(packages[1].keyPackageRef)
  assert.equal(directMatch?.id, packages[1].id)
  assert.deepEqual([...directMatch.publicData], [7, 8, 9])

  await runtime.consumeKeyPackage(packages[1].id)
  const missing = await runtime.loadKeyPackageByRef(packages[1].keyPackageRef)
  assert.equal(missing, null)
})

test('cached messages stay scoped even when channel and dm ids collide', async (t) => {
  const { runtime, storage } = configureMemoryStorage()
  t.after(() => {
    runtime.reset()
  })

  await runtime.cacheMessage({
    id: 'channel-message',
    roomSeq: 2,
    channelId: 'scope-1',
    conversationId: null,
    serverId: 'server-1',
    senderId: 'sender-1',
    senderUsername: 'alpha',
    parentMessageId: null,
    ciphertext: null,
    decryptedContent: 'channel body',
    mlsEpoch: null,
    insertedAt: '2026-03-18T01:00:00.000Z'
  })
  await runtime.saveCachedMessageDecryption('channel-message', 'channel body')

  await runtime.cacheMessage({
    id: 'dm-message',
    roomSeq: 1,
    channelId: null,
    conversationId: 'scope-1',
    serverId: null,
    senderId: 'sender-2',
    senderUsername: 'beta',
    parentMessageId: null,
    ciphertext: null,
    decryptedContent: 'dm body',
    mlsEpoch: null,
    insertedAt: '2026-03-18T00:59:00.000Z'
  })
  await runtime.saveCachedMessageDecryption('dm-message', 'dm body')

  await runtime.cacheMessage({
    id: 'other-scope-message',
    roomSeq: 3,
    channelId: 'scope-2',
    conversationId: null,
    serverId: 'server-2',
    senderId: 'sender-3',
    senderUsername: 'gamma',
    parentMessageId: null,
    ciphertext: null,
    decryptedContent: 'other body',
    mlsEpoch: null,
    insertedAt: '2026-03-18T01:01:00.000Z'
  })
  await runtime.saveCachedMessageDecryption('other-scope-message', 'other body')
  await storage.indexDecryptedMessage('channel-message', 'scope-1', 'channel body')
  await storage.indexDecryptedMessage('dm-message', 'scope-1', 'dm body')
  await storage.indexDecryptedMessage('other-scope-message', 'scope-2', 'other body')

  const scopedMessages = await runtime.loadCachedMessages('scope-1')
  assert.deepEqual(
    scopedMessages.map((message) => message.id),
    ['dm-message', 'channel-message']
  )

  await runtime.clearCachedMessages('scope-1')
  const clearedMessages = await runtime.loadCachedMessages('scope-1')
  assert.deepEqual(clearedMessages, [])
  assert.equal(await runtime.loadCachedMessageDecryption('channel-message'), null)
  assert.equal(await runtime.loadCachedMessageDecryption('dm-message'), null)
  assert.deepEqual(
    (await runtime.searchDecryptedMessages('body', 'scope-1')).map((entry) => entry.messageId),
    []
  )

  const untouchedMessages = await runtime.loadCachedMessages('scope-2')
  assert.deepEqual(untouchedMessages.map((message) => message.id), ['other-scope-message'])
  assert.equal(await runtime.loadCachedMessageDecryption('other-scope-message'), 'other body')
})

test('deterministic fault helpers preserve durable outcomes across ack loss, duplicate delivery, replay reorder, and restart', async (t) => {
  const storage = new MemoryStorage()
  const userId = `fault-hotpaths-${Date.now()}-${Math.random()}`
  let runtime = createCryptoStorageRuntime(storage)
  runtime.init(userId)
  t.after(() => {
    runtime.reset()
  })

  await assert.rejects(
    injectDroppedAck(async () => {
      await runtime.savePendingMessageSend({
        clientNonce: 'fault-nonce',
        scopeKind: 'channel',
        scopeId: 'fault-scope',
        scopeChannelId: 'fault-scope',
        payloadJson: '{"v":1,"type":"text","text":"persist before ack"}',
        insertedAt: '2026-07-15T00:00:00.000Z'
      })
    }),
    InjectedDroppedAckError
  )
  assert.deepEqual(
    (await runtime.loadPendingMessageSends()).map((entry) => entry.clientNonce),
    ['fault-nonce']
  )

  await injectDuplicateDelivery(
    {
      id: 'duplicate-message',
      roomSeq: 7,
      channelId: 'fault-scope',
      conversationId: null,
      serverId: 'fault-server',
      senderId: 'fault-sender',
      senderUsername: 'fault-user',
      parentMessageId: null,
      threadRootMessageId: null,
      replyToMessageId: null,
      isReply: false,
      ciphertext: null,
      decryptedContent: 'delivered once',
      mlsEpoch: null,
      insertedAt: '2026-07-15T00:00:01.000Z'
    },
    async (message) => await runtime.cacheMessage(message)
  )
  assert.deepEqual(
    (await runtime.loadCachedMessages('fault-scope')).map((message) => message.id),
    ['duplicate-message']
  )

  assert.deepEqual(
    injectReorderedReplayPage([{ seq: 7 }, { seq: 8 }, { seq: 9 }]).map((event) => event.seq),
    [8, 7, 9]
  )

  await runtime.saveScopeCheckpoint('fault-scope', {
    groupId: 'fault-scope',
    groupState: null,
    lastEventSeq: 9,
    recentCommitFingerprints: [],
    recentHistoryBundleFingerprints: [],
    repairState: null,
    controlIntents: []
  })

  runtime = await injectRestart(
    () => runtime.reset(),
    () => {
      const restarted = createCryptoStorageRuntime(storage)
      restarted.init(userId)
      return restarted
    }
  )
  assert.equal((await runtime.loadScopeCheckpoint('fault-scope')).lastEventSeq, 9)
})

test('deleting group state preserves the checkpoint replay cursor', async (t) => {
  const { runtime } = configureMemoryStorage()
  t.after(() => {
    runtime.reset()
  })

  await runtime.saveScopeCheckpoint('scope-1', {
    groupId: 'scope-1',
    groupState: {
      state: Uint8Array.from([1, 2, 3]),
      epoch: 7
    },
    lastEventSeq: 42,
    recentCommitFingerprints: [],
    recentHistoryBundleFingerprints: [],
    repairState: null,
    controlIntents: []
  })
  assert.equal((await runtime.loadScopeCheckpoint('scope-1')).lastEventSeq, 42)

  await runtime.deleteGroupState('scope-1')
  // Cursor must survive group deletion to prevent replay death spirals
  // (stale mls_remove events re-deleting the group on every replay)
  assert.equal((await runtime.loadScopeCheckpoint('scope-1')).lastEventSeq, 42)
})

for (const adapter of ['memory', 'file']) {
  test(`${adapter} storage persists the account workspace and cursor atomically`, async (t) => {
    const directory = adapter === 'file' ? await mkdtemp(path.join(tmpdir(), 'vesper-workspace-')) : null
    const filePath = directory ? path.join(directory, 'crypto.json') : null
    const storage = adapter === 'file' ? new FileCryptoStorage(filePath) : new MemoryStorage()
    const runtime = createCryptoStorageRuntime(storage)
    const userId = `workspace-contract-${adapter}`
    runtime.init(userId)

    t.after(async () => {
      runtime.reset()
      if (directory) {
        await rm(directory, { recursive: true, force: true })
      }
    })

    const snapshot = {
      version: 1,
      token: 'cursor-42',
      serversJson: JSON.stringify([{ id: 'server-1', channels: [] }]),
      conversationsJson: JSON.stringify([{ id: 'dm-1', participants: [] }]),
      unreadCountsJson: JSON.stringify({ channels: {}, conversations: { 'dm-1': 2 } }),
      updatedAt: '2026-07-26T00:00:00.000Z'
    }

    await runtime.saveWorkspaceSnapshot(userId, snapshot)
    assert.deepEqual(await runtime.loadWorkspaceSnapshot(userId), snapshot)

    runtime.reset()
    const restarted = createCryptoStorageRuntime(storage)
    restarted.init(userId)
    assert.deepEqual(await restarted.loadWorkspaceSnapshot(userId), snapshot)
    restarted.reset()
  })

  test(`${adapter} storage preserves multiple journal intents and durable results`, async (t) => {
    const directory = adapter === 'file' ? await mkdtemp(path.join(tmpdir(), 'vesper-storage-')) : null
    const filePath = directory ? path.join(directory, 'crypto.json') : null
    const storage = adapter === 'file' ? new FileCryptoStorage(filePath) : new MemoryStorage()
    const runtime = createCryptoStorageRuntime(storage)
    runtime.init(`journal-contract-${adapter}`)

    t.after(async () => {
      runtime.reset()
      if (directory) {
        await rm(directory, { recursive: true, force: true })
      }
    })

    const intent = (idempotencyKey, state, resultJson = null) => ({
      version: 1,
      operation: 'mls_history_bundle',
      idempotencyKey,
      scopeId: 'journal-scope',
      membershipGeneration: 7,
      payloadJson: JSON.stringify({ requestId: idempotencyKey }),
      attempts: state === 'pending' ? 0 : 1,
      state,
      resultJson,
      createdAt: '2026-07-15T00:00:00.000Z',
      updatedAt: '2026-07-15T00:00:01.000Z'
    })

    await runtime.saveScopeCheckpoint('journal-scope', {
      groupId: 'journal-scope',
      groupState: null,
      lastEventSeq: 11,
      recentCommitFingerprints: [],
      recentHistoryBundleFingerprints: [],
      repairState: null,
      controlIntents: [
        intent('history-1', 'pending'),
        intent('history-2', 'accepted', '{"bundle_id":"bundle-2"}')
      ]
    })

    const checkpoint = await runtime.loadScopeCheckpoint('journal-scope')
    assert.equal(checkpoint.lastEventSeq, 11)
    assert.deepEqual(
      checkpoint.controlIntents.map((entry) => [entry.idempotencyKey, entry.state, entry.resultJson]),
      [
        ['history-1', 'pending', null],
        ['history-2', 'accepted', '{"bundle_id":"bundle-2"}']
      ]
    )
  })
}

test('file storage migrates legacy control records into the checkpoint journal once', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'vesper-storage-migration-'))
  const filePath = path.join(directory, 'crypto.json')
  t.after(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  await writeFile(filePath, JSON.stringify({
    nextKeyPackageId: 1,
    identityKeys: {},
    groupStates: { 'legacy-scope': { state: null, epoch: 3 } },
    groupSyncCursors: { 'legacy-scope': 9 },
    scopeMetadata: {},
    pendingGroupInfoPublishes: {
      'legacy-scope': {
        group_info_data: 'AQID',
        ratchet_tree_data: null,
        epoch: 3
      }
    },
    keyPackages: [],
    cachedMessages: {},
    cachedDecryptions: {},
    sentPlaintext: {},
    searchIndex: {},
    pendingMessageSends: {}
  }))

  const storage = new FileCryptoStorage(filePath)
  const checkpoint = await storage.getScopeCheckpoint('legacy-scope')
  assert.equal(checkpoint.control_intents.length, 1)
  assert.equal(checkpoint.control_intents[0]?.operation, 'group_info_publish')

  const persisted = JSON.parse(await readFile(filePath, 'utf8'))
  assert.equal('pendingGroupInfoPublishes' in persisted, false)
  assert.equal(persisted.scopeMetadata['legacy-scope'].control_intents.length, 1)
})
