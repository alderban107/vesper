/**
 * Tests for the Signal Protocol implementation.
 *
 * Run: npx tsx sdk/src/crypto/signal.test.ts
 */
import {
  generateIdentityKeyPair,
  generateSignedPreKey,
  generateOneTimePreKeys,
  buildPreKeyBundle,
  performX3DH,
  respondX3DH,
  initSessionAsInitiator,
  initSessionAsResponder,
  ratchetEncrypt,
  ratchetDecrypt,
  generateSenderKey,
  senderKeyEncrypt,
  senderKeyDecrypt,
  createSenderKeyReceiver,
  deriveVoiceKey,
  serializeSession,
  deserializeSession,
  serializeSenderKey,
  deserializeSenderKey,
  serializeSenderKeyReceiver,
  deserializeSenderKeyReceiver,
  encodePreKeyBundle,
  decodePreKeyBundle,
  encodeMessage,
  decodeMessage,
  type SessionState,
  type SenderKeyState,
  type SenderKeyReceiver,
} from './protocol.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++
  } else {
    failed++
    console.error(`  ✗ ${message}`)
  }
}

function assertEq(a: unknown, b: unknown, message: string): void {
  if (a === b) {
    passed++
  } else {
    failed++
    console.error(`  ✗ ${message}: expected ${b}, got ${a}`)
  }
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${name}: ${err}`)
  }
}

// ==========================================================================

console.log('\n=== Key Generation ===')

await test('generates identity key pairs', async () => {
  const identity = generateIdentityKeyPair()
  assertEq(identity.signing.publicKey.length, 32, 'signing pubkey is 32 bytes')
  assertEq(identity.signing.privateKey.length, 32, 'signing privkey is 32 bytes')
  assertEq(identity.dh.publicKey.length, 32, 'dh pubkey is 32 bytes')
  assertEq(identity.dh.privateKey.length, 32, 'dh privkey is 32 bytes')
})

await test('generates signed pre-keys', async () => {
  const identity = generateIdentityKeyPair()
  const spk = generateSignedPreKey(identity.signing, 1)
  assertEq(spk.id, 1, 'id matches')
  assertEq(spk.keyPair.publicKey.length, 32, 'pubkey is 32 bytes')
  assertEq(spk.signature.length, 64, 'signature is 64 bytes')
})

await test('generates one-time pre-keys', async () => {
  const otpks = generateOneTimePreKeys(100, 5)
  assertEq(otpks.length, 5, 'generates requested count')
  assertEq(otpks[0].id, 100, 'first id matches startId')
  assertEq(otpks[4].id, 104, 'last id is startId + count - 1')
})

// ==========================================================================

console.log('\n=== Pre-Key Bundle Serialization ===')

await test('encode/decode pre-key bundle round-trips', async () => {
  const identity = generateIdentityKeyPair()
  const spk = generateSignedPreKey(identity.signing, 42)
  const otpks = generateOneTimePreKeys(100, 3)
  const bundle = buildPreKeyBundle(identity, spk, otpks)

  const encoded = encodePreKeyBundle(bundle)
  const decoded = decodePreKeyBundle(encoded)

  assert(arraysEqual(decoded.identityKey, bundle.identityKey), 'identity key matches')
  assert(arraysEqual(decoded.identityDHKey, bundle.identityDHKey), 'identity DH key matches')
  assertEq(decoded.signedPreKey.id, 42, 'signed pre-key id matches')
  assert(arraysEqual(decoded.signedPreKey.publicKey, bundle.signedPreKey.publicKey), 'SPK pubkey matches')
  assert(arraysEqual(decoded.signedPreKey.signature, bundle.signedPreKey.signature), 'SPK signature matches')
  assertEq(decoded.oneTimePreKeys.length, 3, 'OPK count matches')
  assertEq(decoded.oneTimePreKeys[0].id, 100, 'first OPK id matches')
})

// ==========================================================================

console.log('\n=== X3DH Key Agreement ===')

await test('X3DH produces matching shared secrets (with OPK)', async () => {
  const alice = generateIdentityKeyPair()
  const bob = generateIdentityKeyPair()

  const bobSpk = generateSignedPreKey(bob.signing, 1)
  const bobOtpks = generateOneTimePreKeys(1, 5)
  const bobBundle = buildPreKeyBundle(bob, bobSpk, bobOtpks)

  // Alice initiates
  const aliceResult = performX3DH(alice, bobBundle, bobBundle.oneTimePreKeys[0])

  // Bob responds
  const bobSecret = respondX3DH(
    bob,
    bobSpk,
    bobOtpks[0],
    alice.dh.publicKey,
    aliceResult.ephemeralPublicKey
  )

  assert(arraysEqual(aliceResult.sharedSecret, bobSecret), 'shared secrets match')
  assertEq(aliceResult.usedOneTimePreKeyId, 1, 'used OPK id is correct')
  assertEq(aliceResult.ephemeralPublicKey.length, 32, 'ephemeral key is 32 bytes')
})

await test('X3DH produces matching shared secrets (without OPK)', async () => {
  const alice = generateIdentityKeyPair()
  const bob = generateIdentityKeyPair()

  const bobSpk = generateSignedPreKey(bob.signing, 1)
  const bobBundle = buildPreKeyBundle(bob, bobSpk, [])

  const aliceResult = performX3DH(alice, bobBundle)

  const bobSecret = respondX3DH(
    bob,
    bobSpk,
    null,
    alice.dh.publicKey,
    aliceResult.ephemeralPublicKey
  )

  assert(arraysEqual(aliceResult.sharedSecret, bobSecret), 'shared secrets match without OPK')
  assertEq(aliceResult.usedOneTimePreKeyId, null, 'no OPK used')
})

await test('X3DH rejects invalid signed pre-key signature', async () => {
  const alice = generateIdentityKeyPair()
  const bob = generateIdentityKeyPair()

  const bobSpk = generateSignedPreKey(bob.signing, 1)
  const bobBundle = buildPreKeyBundle(bob, bobSpk, [])

  // Corrupt the signature
  bobBundle.signedPreKey.signature[0] ^= 0xff

  try {
    performX3DH(alice, bobBundle)
    assert(false, 'should have thrown')
  } catch (e: unknown) {
    assert((e as Error).message.includes('signature verification failed'), 'correct error message')
  }
})

// ==========================================================================

console.log('\n=== Double Ratchet ===')

await test('basic encrypt/decrypt', async () => {
  const alice = generateIdentityKeyPair()
  const bob = generateIdentityKeyPair()
  const bobSpk = generateSignedPreKey(bob.signing, 1)
  const bobBundle = buildPreKeyBundle(bob, bobSpk, [])

  // X3DH
  const aliceX3dh = performX3DH(alice, bobBundle)
  const bobSecret = respondX3DH(bob, bobSpk, null, alice.dh.publicKey, aliceX3dh.ephemeralPublicKey)

  // Init sessions
  let aliceSession = initSessionAsInitiator(aliceX3dh.sharedSecret, bobSpk.keyPair.publicKey)
  let bobSession = initSessionAsResponder(bobSecret, bobSpk.keyPair)

  // Alice sends to Bob
  const msg = encoder.encode('Hello Bob!')
  const encrypted = await ratchetEncrypt(aliceSession, msg)
  aliceSession = encrypted.session

  const decrypted = await ratchetDecrypt(bobSession, encrypted.message)
  assert(decrypted !== null, 'decryption succeeded')
  assert(arraysEqual(decrypted!.plaintext, msg), 'plaintext matches')
  bobSession = decrypted!.session
})

await test('bidirectional messaging', async () => {
  const alice = generateIdentityKeyPair()
  const bob = generateIdentityKeyPair()
  const bobSpk = generateSignedPreKey(bob.signing, 1)
  const bobBundle = buildPreKeyBundle(bob, bobSpk, [])

  const aliceX3dh = performX3DH(alice, bobBundle)
  const bobSecret = respondX3DH(bob, bobSpk, null, alice.dh.publicKey, aliceX3dh.ephemeralPublicKey)

  let aliceSession = initSessionAsInitiator(aliceX3dh.sharedSecret, bobSpk.keyPair.publicKey)
  let bobSession = initSessionAsResponder(bobSecret, bobSpk.keyPair)

  // Alice → Bob
  const e1 = await ratchetEncrypt(aliceSession, encoder.encode('msg1'))
  aliceSession = e1.session
  const d1 = await ratchetDecrypt(bobSession, e1.message)
  assert(d1 !== null, 'msg1 decrypted')
  assertEq(decoder.decode(d1!.plaintext), 'msg1', 'msg1 content')
  bobSession = d1!.session

  // Bob → Alice
  const e2 = await ratchetEncrypt(bobSession, encoder.encode('msg2'))
  bobSession = e2.session
  const d2 = await ratchetDecrypt(aliceSession, e2.message)
  assert(d2 !== null, 'msg2 decrypted')
  assertEq(decoder.decode(d2!.plaintext), 'msg2', 'msg2 content')
  aliceSession = d2!.session

  // Alice → Bob again
  const e3 = await ratchetEncrypt(aliceSession, encoder.encode('msg3'))
  aliceSession = e3.session
  const d3 = await ratchetDecrypt(bobSession, e3.message)
  assert(d3 !== null, 'msg3 decrypted')
  assertEq(decoder.decode(d3!.plaintext), 'msg3', 'msg3 content')
  bobSession = d3!.session
})

await test('multiple messages in same direction', async () => {
  const alice = generateIdentityKeyPair()
  const bob = generateIdentityKeyPair()
  const bobSpk = generateSignedPreKey(bob.signing, 1)
  const bobBundle = buildPreKeyBundle(bob, bobSpk, [])

  const aliceX3dh = performX3DH(alice, bobBundle)
  const bobSecret = respondX3DH(bob, bobSpk, null, alice.dh.publicKey, aliceX3dh.ephemeralPublicKey)

  let aliceSession = initSessionAsInitiator(aliceX3dh.sharedSecret, bobSpk.keyPair.publicKey)
  let bobSession = initSessionAsResponder(bobSecret, bobSpk.keyPair)

  // Alice sends 5 messages in a row
  const messages: Awaited<ReturnType<typeof ratchetEncrypt>>[] = []
  for (let i = 0; i < 5; i++) {
    const encrypted = await ratchetEncrypt(aliceSession, encoder.encode(`message ${i}`))
    aliceSession = encrypted.session
    messages.push(encrypted)
  }

  // Bob decrypts all 5
  for (let i = 0; i < 5; i++) {
    const decrypted = await ratchetDecrypt(bobSession, messages[i].message)
    assert(decrypted !== null, `message ${i} decrypted`)
    assertEq(decoder.decode(decrypted!.plaintext), `message ${i}`, `message ${i} content`)
    bobSession = decrypted!.session
  }
})

await test('out-of-order messages', async () => {
  const alice = generateIdentityKeyPair()
  const bob = generateIdentityKeyPair()
  const bobSpk = generateSignedPreKey(bob.signing, 1)
  const bobBundle = buildPreKeyBundle(bob, bobSpk, [])

  const aliceX3dh = performX3DH(alice, bobBundle)
  const bobSecret = respondX3DH(bob, bobSpk, null, alice.dh.publicKey, aliceX3dh.ephemeralPublicKey)

  let aliceSession = initSessionAsInitiator(aliceX3dh.sharedSecret, bobSpk.keyPair.publicKey)
  let bobSession = initSessionAsResponder(bobSecret, bobSpk.keyPair)

  // Alice sends 3 messages
  const e1 = await ratchetEncrypt(aliceSession, encoder.encode('first'))
  aliceSession = e1.session
  const e2 = await ratchetEncrypt(aliceSession, encoder.encode('second'))
  aliceSession = e2.session
  const e3 = await ratchetEncrypt(aliceSession, encoder.encode('third'))
  aliceSession = e3.session

  // Bob receives them out of order: 3rd, 1st, 2nd
  const d3 = await ratchetDecrypt(bobSession, e3.message)
  assert(d3 !== null, 'third message decrypted first')
  assertEq(decoder.decode(d3!.plaintext), 'third', 'third content')
  bobSession = d3!.session

  const d1 = await ratchetDecrypt(bobSession, e1.message)
  assert(d1 !== null, 'first message decrypted (skipped key)')
  assertEq(decoder.decode(d1!.plaintext), 'first', 'first content')
  bobSession = d1!.session

  const d2 = await ratchetDecrypt(bobSession, e2.message)
  assert(d2 !== null, 'second message decrypted (skipped key)')
  assertEq(decoder.decode(d2!.plaintext), 'second', 'second content')
  bobSession = d2!.session
})

await test('message wire format round-trips', async () => {
  const alice = generateIdentityKeyPair()
  const bob = generateIdentityKeyPair()
  const bobSpk = generateSignedPreKey(bob.signing, 1)
  const bobBundle = buildPreKeyBundle(bob, bobSpk, [])

  const aliceX3dh = performX3DH(alice, bobBundle)
  const bobSecret = respondX3DH(bob, bobSpk, null, alice.dh.publicKey, aliceX3dh.ephemeralPublicKey)

  let aliceSession = initSessionAsInitiator(aliceX3dh.sharedSecret, bobSpk.keyPair.publicKey)
  let bobSession = initSessionAsResponder(bobSecret, bobSpk.keyPair)

  const encrypted = await ratchetEncrypt(aliceSession, encoder.encode('wire format test'))
  aliceSession = encrypted.session

  // Encode → decode
  const wire = encodeMessage(encrypted.message)
  const decoded = decodeMessage(wire)

  assert(arraysEqual(decoded.header.publicKey, encrypted.message.header.publicKey), 'header pubkey matches')
  assertEq(decoded.header.messageNumber, encrypted.message.header.messageNumber, 'msg number matches')
  assert(arraysEqual(decoded.ciphertext, encrypted.message.ciphertext), 'ciphertext matches')

  // Decrypt the decoded message
  const decrypted = await ratchetDecrypt(bobSession, decoded)
  assert(decrypted !== null, 'decoded message decrypts')
  assertEq(decoder.decode(decrypted!.plaintext), 'wire format test', 'content matches')
})

// ==========================================================================

console.log('\n=== Session Serialization ===')

await test('session serialize/deserialize round-trips', async () => {
  const alice = generateIdentityKeyPair()
  const bob = generateIdentityKeyPair()
  const bobSpk = generateSignedPreKey(bob.signing, 1)
  const bobBundle = buildPreKeyBundle(bob, bobSpk, [])

  const aliceX3dh = performX3DH(alice, bobBundle)
  const bobSecret = respondX3DH(bob, bobSpk, null, alice.dh.publicKey, aliceX3dh.ephemeralPublicKey)

  let aliceSession = initSessionAsInitiator(aliceX3dh.sharedSecret, bobSpk.keyPair.publicKey)
  let bobSession = initSessionAsResponder(bobSecret, bobSpk.keyPair)

  // Send a message to advance state
  const e = await ratchetEncrypt(aliceSession, encoder.encode('test'))
  aliceSession = e.session

  // Serialize and restore Alice's session
  const serialized = serializeSession(aliceSession)
  const restored = deserializeSession(serialized)

  // Send another message with restored session
  const e2 = await ratchetEncrypt(restored, encoder.encode('after restore'))

  // Bob should decrypt both
  const d1 = await ratchetDecrypt(bobSession, e.message)
  assert(d1 !== null, 'first message decrypts')
  bobSession = d1!.session

  const d2 = await ratchetDecrypt(bobSession, e2.message)
  assert(d2 !== null, 'post-restore message decrypts')
  assertEq(decoder.decode(d2!.plaintext), 'after restore', 'post-restore content')
})

// ==========================================================================

console.log('\n=== Sender Keys (Group Messaging) ===')

await test('basic sender key encrypt/decrypt', async () => {
  let senderState = generateSenderKey()

  // Create receiver copy
  let receiver = createSenderKeyReceiver(
    senderState.chainKey,
    senderState.signingKey.publicKey
  )

  // Encrypt
  const result = await senderKeyEncrypt(senderState, encoder.encode('group message'))
  senderState = result.state

  // Decrypt
  const decrypted = await senderKeyDecrypt(receiver, result.ciphertext, result.signature, result.iteration)
  assert(decrypted !== null, 'decryption succeeded')
  assertEq(decoder.decode(decrypted!.plaintext), 'group message', 'content matches')
  receiver = decrypted!.receiver
})

await test('multiple sender key messages', async () => {
  let senderState = generateSenderKey()
  let receiver = createSenderKeyReceiver(
    senderState.chainKey,
    senderState.signingKey.publicKey
  )

  for (let i = 0; i < 10; i++) {
    const result = await senderKeyEncrypt(senderState, encoder.encode(`msg ${i}`))
    senderState = result.state

    const decrypted = await senderKeyDecrypt(receiver, result.ciphertext, result.signature, result.iteration)
    assert(decrypted !== null, `msg ${i} decrypted`)
    assertEq(decoder.decode(decrypted!.plaintext), `msg ${i}`, `msg ${i} content`)
    receiver = decrypted!.receiver
  }
})

await test('sender key rejects invalid signature', async () => {
  let senderState = generateSenderKey()
  let receiver = createSenderKeyReceiver(
    senderState.chainKey,
    senderState.signingKey.publicKey
  )

  const result = await senderKeyEncrypt(senderState, encoder.encode('test'))

  // Corrupt the signature
  const badSig = new Uint8Array(result.signature)
  badSig[0] ^= 0xff

  const decrypted = await senderKeyDecrypt(receiver, result.ciphertext, badSig, result.iteration)
  assertEq(decrypted, null, 'rejects invalid signature')
})

await test('sender key serialization round-trips', async () => {
  const state = generateSenderKey()
  const serialized = serializeSenderKey(state)
  const restored = deserializeSenderKey(serialized)

  assert(arraysEqual(restored.chainKey, state.chainKey), 'chain key matches')
  assert(arraysEqual(restored.signingKey.publicKey, state.signingKey.publicKey), 'signing pubkey matches')
  assertEq(restored.iteration, state.iteration, 'iteration matches')
})

await test('sender key receiver serialization round-trips', async () => {
  const state = generateSenderKey()
  const receiver = createSenderKeyReceiver(state.chainKey, state.signingKey.publicKey, 5)

  const serialized = serializeSenderKeyReceiver(receiver)
  const restored = deserializeSenderKeyReceiver(serialized)

  assert(arraysEqual(restored.chainKey, receiver.chainKey), 'chain key matches')
  assert(arraysEqual(restored.signingPublicKey, receiver.signingPublicKey), 'signing pubkey matches')
  assertEq(restored.iteration, 5, 'iteration matches')
})

// ==========================================================================

console.log('\n=== Voice Key Derivation ===')

await test('derives deterministic 128-bit voice key', async () => {
  const secret = new Uint8Array(32).fill(0x42)
  const key1 = deriveVoiceKey(secret)
  const key2 = deriveVoiceKey(secret)

  assertEq(key1.length, 16, 'voice key is 16 bytes (128 bits)')
  assert(arraysEqual(key1, key2), 'deterministic: same input → same output')

  const differentSecret = new Uint8Array(32).fill(0x43)
  const key3 = deriveVoiceKey(differentSecret)
  assert(!arraysEqual(key1, key3), 'different input → different output')
})

// ==========================================================================

console.log('\n=== Full Integration: X3DH → Double Ratchet → Sender Keys ===')

await test('complete session lifecycle', async () => {
  // Setup identities
  const alice = generateIdentityKeyPair()
  const bob = generateIdentityKeyPair()

  // Bob publishes pre-key bundle
  const bobSpk = generateSignedPreKey(bob.signing, 1)
  const bobOtpks = generateOneTimePreKeys(1, 10)
  const bobBundle = buildPreKeyBundle(bob, bobSpk, bobOtpks)

  // Alice initiates X3DH (Bob is OFFLINE — key bundle fetched from server)
  const aliceX3dh = performX3DH(alice, bobBundle, bobBundle.oneTimePreKeys[0])

  // Alice initializes Double Ratchet and sends first message
  let aliceSession = initSessionAsInitiator(aliceX3dh.sharedSecret, bobSpk.keyPair.publicKey)
  const e1 = await ratchetEncrypt(aliceSession, encoder.encode('Hey Bob, you there?'))
  aliceSession = e1.session

  // ... time passes, Bob comes online ...

  // Bob completes X3DH and initializes his session
  const bobSecret = respondX3DH(bob, bobSpk, bobOtpks[0], alice.dh.publicKey, aliceX3dh.ephemeralPublicKey)
  let bobSession = initSessionAsResponder(bobSecret, bobSpk.keyPair)

  // Bob decrypts Alice's first message
  const d1 = await ratchetDecrypt(bobSession, e1.message)
  assert(d1 !== null, 'Bob decrypts Alice msg 1')
  assertEq(decoder.decode(d1!.plaintext), 'Hey Bob, you there?', 'msg 1 content')
  bobSession = d1!.session

  // Bob replies
  const e2 = await ratchetEncrypt(bobSession, encoder.encode('Yeah! Just got online.'))
  bobSession = e2.session

  const d2 = await ratchetDecrypt(aliceSession, e2.message)
  assert(d2 !== null, 'Alice decrypts Bob msg')
  assertEq(decoder.decode(d2!.plaintext), 'Yeah! Just got online.', 'Bob reply content')
  aliceSession = d2!.session

  // Now they want to set up a group chat
  // Each generates a sender key and distributes via pairwise session
  let aliceSenderKey = generateSenderKey()
  let bobSenderKey = generateSenderKey()

  // Distribution would happen via ratchetEncrypt (the pairwise channel)
  // For testing, just create receivers directly
  let bobReceivesAlice = createSenderKeyReceiver(
    aliceSenderKey.chainKey,
    aliceSenderKey.signingKey.publicKey
  )
  let aliceReceivesBob = createSenderKeyReceiver(
    bobSenderKey.chainKey,
    bobSenderKey.signingKey.publicKey
  )

  // Alice sends a group message
  const ge1 = await senderKeyEncrypt(aliceSenderKey, encoder.encode('Group hello!'))
  aliceSenderKey = ge1.state

  const gd1 = await senderKeyDecrypt(bobReceivesAlice, ge1.ciphertext, ge1.signature, ge1.iteration)
  assert(gd1 !== null, 'Bob decrypts group msg from Alice')
  assertEq(decoder.decode(gd1!.plaintext), 'Group hello!', 'group msg content')
  bobReceivesAlice = gd1!.receiver

  // Bob sends a group message
  const ge2 = await senderKeyEncrypt(bobSenderKey, encoder.encode('Group reply!'))
  bobSenderKey = ge2.state

  const gd2 = await senderKeyDecrypt(aliceReceivesBob, ge2.ciphertext, ge2.signature, ge2.iteration)
  assert(gd2 !== null, 'Alice decrypts group msg from Bob')
  assertEq(decoder.decode(gd2!.plaintext), 'Group reply!', 'group reply content')
  aliceReceivesBob = gd2!.receiver

  // Voice key derivation
  const voiceKey = deriveVoiceKey(aliceSession.rootKey)
  assertEq(voiceKey.length, 16, 'voice key is 128 bits')
})

// ==========================================================================

console.log('\n' + '='.repeat(50))
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
} else {
  console.log('All tests passed! ✓')
}
