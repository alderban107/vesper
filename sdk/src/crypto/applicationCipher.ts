const SCHEME = 'vesper-room-v1'

export type RoomApplicationOperation = 'message' | 'edit' | 'reaction' | 'history'

export interface RoomApplicationContext {
  roomId: string
  roomKeyEpoch: number
  senderUserId: string
  senderDeviceId: string
  operation: RoomApplicationOperation
  eventId: string
}

interface RoomApplicationEnvelope extends RoomApplicationContext {
  v: 1
  scheme: typeof SCHEME
  nonce: string
  ciphertext: string
}

export async function encryptRoomApplication(
  roomKey: Uint8Array,
  context: RoomApplicationContext,
  plaintext: string,
  nonce: Uint8Array = crypto.getRandomValues(new Uint8Array(12))
): Promise<string> {
  assertLength(roomKey, 32, 'room key')
  assertLength(nonce, 12, 'nonce')
  const aad = contextBytes(context)
  const key = await deriveEventKey(roomKey, aad, ['encrypt'])
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad as BufferSource },
      key,
      new TextEncoder().encode(plaintext) as BufferSource
    )
  )
  const envelope: RoomApplicationEnvelope = {
    v: 1,
    scheme: SCHEME,
    ...context,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ciphertext)
  }
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(envelope)))
}

export async function decryptRoomApplication(
  roomKey: Uint8Array,
  encoded: string,
  expected: Pick<RoomApplicationContext, 'roomId' | 'operation'> & {
    senderUserId?: string | null
  }
): Promise<{ plaintext: string; context: RoomApplicationContext } | null> {
  const envelope = parseRoomApplicationEnvelope(encoded)
  if (!envelope) return null
  if (
    envelope.roomId !== expected.roomId ||
    envelope.operation !== expected.operation ||
    (expected.senderUserId && envelope.senderUserId !== expected.senderUserId)
  ) {
    throw new Error('room application context mismatch')
  }
  const context: RoomApplicationContext = {
    roomId: envelope.roomId,
    roomKeyEpoch: envelope.roomKeyEpoch,
    senderUserId: envelope.senderUserId,
    senderDeviceId: envelope.senderDeviceId,
    operation: envelope.operation,
    eventId: envelope.eventId
  }
  const aad = contextBytes(context)
  const key = await deriveEventKey(roomKey, aad, ['decrypt'])
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToBytes(envelope.nonce) as BufferSource,
        additionalData: aad as BufferSource
      },
      key,
      base64ToBytes(envelope.ciphertext) as BufferSource
    )
    return { plaintext: new TextDecoder().decode(plaintext), context }
  } catch {
    throw new Error('room application authentication failed')
  }
}

export function parseRoomApplicationEnvelope(encoded: string): RoomApplicationEnvelope | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(base64ToBytes(encoded)))
    if (
      value?.v !== 1 ||
      value?.scheme !== SCHEME ||
      !Number.isInteger(value.roomKeyEpoch) ||
      typeof value.roomId !== 'string' ||
      typeof value.senderUserId !== 'string' ||
      typeof value.senderDeviceId !== 'string' ||
      !['message', 'edit', 'reaction', 'history'].includes(value.operation) ||
      typeof value.eventId !== 'string' ||
      typeof value.nonce !== 'string' ||
      typeof value.ciphertext !== 'string'
    ) return null
    return value as RoomApplicationEnvelope
  } catch {
    return null
  }
}

function contextBytes(context: RoomApplicationContext): Uint8Array {
  return new TextEncoder().encode([
    'scheme=' + SCHEME,
    `room=${context.roomId}`,
    `room_key_epoch=${context.roomKeyEpoch}`,
    `sender_user=${context.senderUserId}`,
    `sender_device=${context.senderDeviceId}`,
    `operation=${context.operation}`,
    `event_id=${context.eventId}`
  ].join('\n'))
}

async function deriveEventKey(roomKey: Uint8Array, info: Uint8Array, usages: KeyUsage[]) {
  const material = await crypto.subtle.importKey('raw', roomKey as BufferSource, 'HKDF', false, ['deriveKey'])
  return await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(SCHEME) as BufferSource,
      info: info as BufferSource
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    usages
  )
}

function bytesToBase64(value: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(value).toString('base64')
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64'))
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function assertLength(value: Uint8Array, expected: number, label: string) {
  if (value.byteLength !== expected) throw new Error(`${label} must be ${expected} bytes`)
}
