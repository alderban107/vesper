import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MemoryStorage,
  cacheMessage,
  clearCachedMessages,
  configureCryptoStorage,
  consumeKeyPackage,
  deleteGroupState,
  initStorage,
  loadCachedMessages,
  loadCachedMessageDecryption,
  loadGroupSyncCursor,
  loadKeyPackageByRef,
  loadKeyPackages,
  saveCachedMessageDecryption,
  saveGroupState,
  saveGroupSyncCursor,
  resetStorage,
  searchDecryptedMessages,
  saveKeyPackages
} from '../dist/storage/index.js'

function configureMemoryStorage() {
  const storage = new MemoryStorage()
  configureCryptoStorage(storage)
  initStorage(`storage-hotpaths-${Date.now()}-${Math.random()}`)
  return storage
}

test('key package refs support direct lookup without scanning the whole set', async (t) => {
  configureMemoryStorage()
  t.after(() => {
    resetStorage()
  })

  await saveKeyPackages([
    {
      publicData: Uint8Array.from([1, 2, 3]),
      privateData: Uint8Array.from([4, 5, 6])
    },
    {
      publicData: Uint8Array.from([7, 8, 9]),
      privateData: Uint8Array.from([10, 11, 12])
    }
  ])

  const packages = await loadKeyPackages()
  assert.equal(packages.length, 2)
  assert.ok(packages[1].keyPackageRef)

  const directMatch = await loadKeyPackageByRef(packages[1].keyPackageRef)
  assert.equal(directMatch?.id, packages[1].id)
  assert.deepEqual([...directMatch.publicData], [7, 8, 9])

  await consumeKeyPackage(packages[1].id)
  const missing = await loadKeyPackageByRef(packages[1].keyPackageRef)
  assert.equal(missing, null)
})

test('cached messages stay scoped even when channel and dm ids collide', async (t) => {
  const storage = configureMemoryStorage()
  t.after(() => {
    resetStorage()
  })

  await cacheMessage({
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
  await saveCachedMessageDecryption('channel-message', 'channel body')

  await cacheMessage({
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
  await saveCachedMessageDecryption('dm-message', 'dm body')

  await cacheMessage({
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
  await saveCachedMessageDecryption('other-scope-message', 'other body')
  await storage.indexDecryptedMessage('channel-message', 'scope-1', 'channel body')
  await storage.indexDecryptedMessage('dm-message', 'scope-1', 'dm body')
  await storage.indexDecryptedMessage('other-scope-message', 'scope-2', 'other body')

  const scopedMessages = await loadCachedMessages('scope-1')
  assert.deepEqual(
    scopedMessages.map((message) => message.id),
    ['dm-message', 'channel-message']
  )

  await clearCachedMessages('scope-1')
  const clearedMessages = await loadCachedMessages('scope-1')
  assert.deepEqual(clearedMessages, [])
  assert.equal(await loadCachedMessageDecryption('channel-message'), null)
  assert.equal(await loadCachedMessageDecryption('dm-message'), null)
  assert.deepEqual(
    (await searchDecryptedMessages('body', 'scope-1')).map((entry) => entry.messageId),
    []
  )

  const untouchedMessages = await loadCachedMessages('scope-2')
  assert.deepEqual(untouchedMessages.map((message) => message.id), ['other-scope-message'])
  assert.equal(await loadCachedMessageDecryption('other-scope-message'), 'other body')
})

test('deleting group state also clears the stored sync cursor', async (t) => {
  configureMemoryStorage()
  t.after(() => {
    resetStorage()
  })

  await saveGroupState('scope-1', Uint8Array.from([1, 2, 3]), 7)
  await saveGroupSyncCursor('scope-1', 42)
  assert.equal(await loadGroupSyncCursor('scope-1'), 42)

  await deleteGroupState('scope-1')
  assert.equal(await loadGroupSyncCursor('scope-1'), 0)
})
