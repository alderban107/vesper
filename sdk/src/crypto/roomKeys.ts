import { x25519 } from '@noble/curves/ed25519.js'

const ROOM_KEY_BYTES = 32
const WRAP_VERSION = 1
const HKDF_SALT = new TextEncoder().encode('vesper-room-key-wrap-v1')

export interface RoomKeyEnvelopeContext {
  roomId: string
  topologyGeneration: number
  roomKeyEpoch: number
  cohortId: string
  groupId: string
  wrappingMlsEpoch: number
}

export interface RoomKeyEnvelope extends RoomKeyEnvelopeContext {
  version: 1
  ephemeralPublicKey: Uint8Array
  nonce: Uint8Array
  ciphertext: Uint8Array
  aadDigest: Uint8Array
}

export function generateRoomDataKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(ROOM_KEY_BYTES))
}

export async function wrapRoomDataKey(
  roomKey: Uint8Array,
  recipientPublicKey: Uint8Array,
  context: RoomKeyEnvelopeContext
): Promise<RoomKeyEnvelope> {
  assertLength(roomKey, ROOM_KEY_BYTES, 'room key')
  assertLength(recipientPublicKey, 32, 'cohort wrapping public key')

  const ephemeralPrivateKey = crypto.getRandomValues(new Uint8Array(32))
  const ephemeralPublicKey = x25519.getPublicKey(ephemeralPrivateKey)
  const sharedSecret = x25519.getSharedSecret(ephemeralPrivateKey, recipientPublicKey)
  const aad = envelopeContextBytes(context)
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const wrappingKey = await deriveWrappingKey(sharedSecret, aad, ['encrypt'])
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad as BufferSource },
      wrappingKey,
      roomKey as BufferSource
    )
  )

  return {
    version: WRAP_VERSION,
    ...context,
    ephemeralPublicKey,
    nonce,
    ciphertext,
    aadDigest: await sha256(aad)
  }
}

export async function unwrapRoomDataKey(
  envelope: RoomKeyEnvelope,
  recipientPrivateKey: Uint8Array,
  expected: RoomKeyEnvelopeContext
): Promise<Uint8Array> {
  assertLength(recipientPrivateKey, 32, 'cohort wrapping private key')
  validateEnvelopeContext(envelope, expected)
  assertLength(envelope.ephemeralPublicKey, 32, 'ephemeral public key')
  assertLength(envelope.nonce, 12, 'envelope nonce')
  assertLength(envelope.ciphertext, 48, 'envelope ciphertext')
  assertLength(envelope.aadDigest, 32, 'envelope AAD digest')

  const aad = envelopeContextBytes(expected)
  if (!equalBytes(await sha256(aad), envelope.aadDigest)) {
    throw new Error('room-key envelope AAD digest mismatch')
  }

  const sharedSecret = x25519.getSharedSecret(recipientPrivateKey, envelope.ephemeralPublicKey)
  const wrappingKey = await deriveWrappingKey(sharedSecret, aad, ['decrypt'])

  try {
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: envelope.nonce as BufferSource,
          additionalData: aad as BufferSource
        },
        wrappingKey,
        envelope.ciphertext as BufferSource
      )
    )
    assertLength(plaintext, ROOM_KEY_BYTES, 'unwrapped room key')
    return plaintext
  } catch {
    throw new Error('room-key envelope authentication failed')
  }
}

export function roomKeyEnvelopeAad(context: RoomKeyEnvelopeContext): Uint8Array {
  return envelopeContextBytes(context)
}

function envelopeContextBytes(context: RoomKeyEnvelopeContext): Uint8Array {
  return new TextEncoder().encode(
    [
      `version=${WRAP_VERSION}`,
      `room=${context.roomId}`,
      `topology=${context.topologyGeneration}`,
      `room_key_epoch=${context.roomKeyEpoch}`,
      `cohort=${context.cohortId}`,
      `group=${context.groupId}`,
      `wrapping_mls_epoch=${context.wrappingMlsEpoch}`
    ].join('\n')
  )
}

function validateEnvelopeContext(
  envelope: RoomKeyEnvelope,
  expected: RoomKeyEnvelopeContext
): void {
  if (
    envelope.version !== WRAP_VERSION ||
    envelope.roomId !== expected.roomId ||
    envelope.topologyGeneration !== expected.topologyGeneration ||
    envelope.roomKeyEpoch !== expected.roomKeyEpoch ||
    envelope.cohortId !== expected.cohortId ||
    envelope.groupId !== expected.groupId ||
    envelope.wrappingMlsEpoch !== expected.wrappingMlsEpoch
  ) {
    throw new Error('room-key envelope context mismatch')
  }
}

async function deriveWrappingKey(
  sharedSecret: Uint8Array,
  info: Uint8Array,
  usages: KeyUsage[]
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    sharedSecret as BufferSource,
    'HKDF',
    false,
    ['deriveKey']
  )

  return await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: HKDF_SALT as BufferSource,
      info: info as BufferSource
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    usages
  )
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', value as BufferSource))
}

function assertLength(value: Uint8Array, expected: number, label: string): void {
  if (value.byteLength !== expected) {
    throw new Error(`${label} must be ${expected} bytes`)
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false
  }

  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index]
  }
  return difference === 0
}
