import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decryptRoomApplication,
  encryptRoomApplication,
  parseRoomApplicationEnvelope
} from '../dist/crypto/index.js'

const key = Uint8Array.from({ length: 32 }, (_, index) => index)
const context = {
  roomId: 'room-vector',
  roomKeyEpoch: 7,
  senderUserId: 'user-vector',
  senderDeviceId: 'device-vector',
  operation: 'message',
  eventId: 'nonce-vector'
}

test('room application ciphertext has a stable vector and authenticated context', async () => {
  const encoded = await encryptRoomApplication(
    key,
    context,
    'hello across cohorts',
    Uint8Array.from({ length: 12 }, (_, index) => index + 1)
  )
  assert.equal(
    encoded,
    'eyJ2IjoxLCJzY2hlbWUiOiJ2ZXNwZXItcm9vbS12MSIsInJvb21JZCI6InJvb20tdmVjdG9yIiwicm9vbUtleUVwb2NoIjo3LCJzZW5kZXJVc2VySWQiOiJ1c2VyLXZlY3RvciIsInNlbmRlckRldmljZUlkIjoiZGV2aWNlLXZlY3RvciIsIm9wZXJhdGlvbiI6Im1lc3NhZ2UiLCJldmVudElkIjoibm9uY2UtdmVjdG9yIiwibm9uY2UiOiJBUUlEQkFVR0J3Z0pDZ3NNIiwiY2lwaGVydGV4dCI6IkErY3l1cVNlcU83NUZFeHQ1cjJPeFQyRFNQbXk0andWU3lnYmxPeUpXNXdMSW1sNCJ9'
  )
  const decrypted = await decryptRoomApplication(key, encoded, {
    roomId: context.roomId,
    operation: 'message',
    senderUserId: context.senderUserId
  })
  assert.equal(decrypted?.plaintext, 'hello across cohorts')
  assert.ok(parseRoomApplicationEnvelope(encoded))

  for (const expected of [
    { roomId: 'other-room', operation: 'message', senderUserId: context.senderUserId },
    { roomId: context.roomId, operation: 'edit', senderUserId: context.senderUserId },
    { roomId: context.roomId, operation: 'message', senderUserId: 'other-user' }
  ]) {
    await assert.rejects(decryptRoomApplication(key, encoded, expected), /context mismatch/)
  }

  const originalEnvelope = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  for (const [field, value] of [
    ['roomKeyEpoch', 8],
    ['senderDeviceId', 'other-device'],
    ['eventId', 'other-event'],
    ['nonce', Buffer.alloc(12, 9).toString('base64')],
    ['ciphertext', Buffer.alloc(36, 7).toString('base64')]
  ]) {
    const tampered = Buffer.from(JSON.stringify({ ...originalEnvelope, [field]: value })).toString('base64')
    await assert.rejects(
      decryptRoomApplication(key, tampered, {
        roomId: context.roomId,
        operation: 'message',
        senderUserId: context.senderUserId
      }),
      /authentication failed/
    )
  }
})

test('random application nonces do not repeat and overhead is member-count independent', async () => {
  const first = await encryptRoomApplication(key, context, 'same plaintext')
  const second = await encryptRoomApplication(key, context, 'same plaintext')
  assert.notEqual(parseRoomApplicationEnvelope(first)?.nonce, parseRoomApplicationEnvelope(second)?.nonce)
  assert.equal(first.length, second.length)
})
