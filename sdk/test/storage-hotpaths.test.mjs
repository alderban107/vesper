import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MemoryStorage,
  createCryptoStorageRuntime
} from '../dist/storage/index.js'

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

test('deleting group state also clears the stored sync cursor', async (t) => {
  const { runtime } = configureMemoryStorage()
  t.after(() => {
    runtime.reset()
  })

  await runtime.saveGroupState('scope-1', Uint8Array.from([1, 2, 3]), 7)
  await runtime.saveGroupSyncCursor('scope-1', 42)
  assert.equal(await runtime.loadGroupSyncCursor('scope-1'), 42)

  await runtime.deleteGroupState('scope-1')
  assert.equal(await runtime.loadGroupSyncCursor('scope-1'), 0)
})
