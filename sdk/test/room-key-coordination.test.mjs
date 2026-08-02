import assert from 'node:assert/strict'
import test from 'node:test'

import {
  generateRoomDataKey,
  unwrapRoomDataKey,
  wrapRoomDataKey
} from '../dist/crypto/index.js'
import { x25519 } from '@noble/curves/ed25519.js'

function context(overrides = {}) {
  return {
    roomId: 'room-1',
    topologyGeneration: 4,
    roomKeyEpoch: 9,
    cohortId: 'cohort-a',
    groupId: 'group-a',
    wrappingMlsEpoch: 12,
    ...overrides
  }
}

test('room data-key envelopes authenticate every topology coordinate', async () => {
  const wrappingPrivateKey = crypto.getRandomValues(new Uint8Array(32))
  const wrappingPublicKey = x25519.getPublicKey(wrappingPrivateKey)
  const roomKey = generateRoomDataKey()
  const envelope = await wrapRoomDataKey(roomKey, wrappingPublicKey, context())

  assert.deepEqual(await unwrapRoomDataKey(envelope, wrappingPrivateKey, context()), roomKey)

  for (const changed of [
    context({ roomId: 'room-2' }),
    context({ topologyGeneration: 5 }),
    context({ roomKeyEpoch: 10 }),
    context({ cohortId: 'cohort-b' }),
    context({ groupId: 'group-b' }),
    context({ wrappingMlsEpoch: 13 })
  ]) {
    await assert.rejects(
      unwrapRoomDataKey(envelope, wrappingPrivateKey, changed),
      /context mismatch/
    )
  }

  const tampered = {
    ...envelope,
    ciphertext: new Uint8Array(envelope.ciphertext)
  }
  tampered.ciphertext[0] ^= 1
  await assert.rejects(
    unwrapRoomDataKey(tampered, wrappingPrivateKey, context()),
    /authentication failed/
  )
})

test('a removed cohort member cannot unwrap the next room-key epoch', async () => {
  const removedPrivateKey = crypto.getRandomValues(new Uint8Array(32))
  const currentPrivateKey = crypto.getRandomValues(new Uint8Array(32))
  const currentPublicKey = x25519.getPublicKey(currentPrivateKey)
  const nextRoomKey = generateRoomDataKey()
  const nextContext = context({ roomKeyEpoch: 10, wrappingMlsEpoch: 13 })
  const envelope = await wrapRoomDataKey(nextRoomKey, currentPublicKey, nextContext)

  assert.deepEqual(
    await unwrapRoomDataKey(envelope, currentPrivateKey, nextContext),
    nextRoomKey
  )
  await assert.rejects(
    unwrapRoomDataKey(envelope, removedPrivateKey, nextContext),
    /authentication failed/
  )
})
