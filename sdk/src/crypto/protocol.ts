/**
 * Vesper encryption protocol implementation.
 *
 * Implements X3DH key agreement, Double Ratchet, and Sender Keys
 * from the published Signal specifications:
 *   - https://signal.org/docs/specifications/x3dh/
 *   - https://signal.org/docs/specifications/doubleratchet/
 *
 * Dependencies: @noble/curves (X25519, Ed25519), @noble/hashes (HKDF, HMAC, SHA-256)
 * No third-party Signal libraries — just the spec + standard crypto primitives.
 */

import { x25519, ed25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { randomBytes } from '@noble/hashes/utils.js'

// ---------------------------------------------------------------------------
//  Constants
// ---------------------------------------------------------------------------

/** Cast to BufferSource for WebCrypto API compatibility */
function asBufferSource(value: Uint8Array): BufferSource {
  return value as unknown as BufferSource
}

/** HKDF info tag for X3DH shared secret derivation */
const X3DH_INFO = new TextEncoder().encode('VesperX3DH')

/** HKDF info tag for root key ratchet */
const RATCHET_INFO = new TextEncoder().encode('VesperRatchet')

/** HKDF info tag for voice key derivation */
const VOICE_KEY_INFO = new TextEncoder().encode('VesperVoiceE2EE')

/**
 * Max number of skipped message keys to store per session.
 * Prevents memory exhaustion from a malicious sender claiming
 * a very high message counter.
 */
const MAX_SKIP = 256

// ---------------------------------------------------------------------------
//  Types
// ---------------------------------------------------------------------------

/** A raw key pair (private + public) for X25519 or Ed25519 */
export interface KeyPair {
  privateKey: Uint8Array  // 32 bytes
  publicKey: Uint8Array   // 32 bytes
}

/** Identity key material for a device — long-term signing + DH keys */
export interface IdentityKeyPair {
  /** Ed25519 signing key pair (long-term identity) */
  signing: KeyPair
  /** X25519 key pair derived from signing key (for X3DH DH1/DH2) */
  dh: KeyPair
}

/** A signed pre-key (medium-term, rotated periodically) */
export interface SignedPreKey {
  id: number
  keyPair: KeyPair        // X25519
  signature: Uint8Array   // Ed25519 signature over the public key
}

/** A one-time pre-key (ephemeral, consumed on use) */
export interface OneTimePreKey {
  id: number
  keyPair: KeyPair        // X25519
}

/**
 * Pre-key bundle published to the server.
 * Contains only public keys — private keys stay on the device.
 */
export interface PreKeyBundle {
  identityKey: Uint8Array       // Ed25519 public key (32 bytes)
  identityDHKey: Uint8Array     // X25519 public key derived from identity (32 bytes)
  signedPreKey: {
    id: number
    publicKey: Uint8Array       // X25519 public key (32 bytes)
    signature: Uint8Array       // Ed25519 signature (64 bytes)
  }
  oneTimePreKeys: Array<{
    id: number
    publicKey: Uint8Array       // X25519 public key (32 bytes)
  }>
}

/** Result of X3DH key agreement (initiator side) */
export interface X3DHResult {
  /** 32-byte shared secret for initializing Double Ratchet */
  sharedSecret: Uint8Array
  /** Ephemeral public key to send to recipient */
  ephemeralPublicKey: Uint8Array
  /** ID of consumed one-time pre-key (if any) */
  usedOneTimePreKeyId: number | null
}

/** Header sent with each Double Ratchet message */
export interface MessageHeader {
  /** Sender's current ratchet public key (X25519, 32 bytes) */
  publicKey: Uint8Array
  /** Previous sending chain length (for skipped key calculation) */
  previousChainLength: number
  /** Message number in current sending chain */
  messageNumber: number
}

/** Encrypted message output */
export interface EncryptedMessage {
  header: MessageHeader
  ciphertext: Uint8Array    // AES-256-GCM ciphertext + 16-byte tag
}

/** Double Ratchet session state */
export interface SessionState {
  /** Our current DH ratchet key pair */
  dhSending: KeyPair
  /** Their current DH ratchet public key */
  dhReceiving: Uint8Array | null
  /** Root key (32 bytes) */
  rootKey: Uint8Array
  /** Sending chain key (32 bytes, null if not yet initialized) */
  chainKeySending: Uint8Array | null
  /** Receiving chain key (32 bytes, null if not yet initialized) */
  chainKeyReceiving: Uint8Array | null
  /** Sending message counter */
  sendingCounter: number
  /** Receiving message counter */
  receivingCounter: number
  /** Previous sending chain length */
  previousChainLength: number
  /** Skipped message keys: Map<"pubkey_hex:counter", messageKey> */
  skippedKeys: Map<string, Uint8Array>
}

/** Sender Key state for group messaging */
export interface SenderKeyState {
  /** Chain key (32 bytes) — ratchets forward per message */
  chainKey: Uint8Array
  /** Ed25519 signing key pair for message authentication */
  signingKey: KeyPair
  /** Current iteration counter */
  iteration: number
}

/** Receiver's copy of a sender key */
export interface SenderKeyReceiver {
  /** Chain key at the iteration we last processed */
  chainKey: Uint8Array
  /** Sender's public signing key (Ed25519, 32 bytes) */
  signingPublicKey: Uint8Array
  /** Last processed iteration */
  iteration: number
  /** Skipped message keys: Map<iteration, messageKey> */
  skippedKeys: Map<number, Uint8Array>
}

// ---------------------------------------------------------------------------
//  Key Generation
// ---------------------------------------------------------------------------

/** Generate an X25519 key pair */
export function generateDHKeyPair(): KeyPair {
  const privateKey = randomBytes(32)
  const publicKey = x25519.getPublicKey(privateKey)
  return { privateKey, publicKey }
}

/** Generate an Ed25519 signing key pair */
export function generateSigningKeyPair(): KeyPair {
  const privateKey = randomBytes(32)
  const publicKey = ed25519.getPublicKey(privateKey)
  return { privateKey, publicKey }
}

/**
 * Generate a full identity key pair.
 * The DH key is derived from the signing key for X3DH compatibility.
 * In X3DH, the identity key is used in DH calculations — we need both
 * Ed25519 (for signing pre-keys) and X25519 (for DH operations).
 */
export function generateIdentityKeyPair(): IdentityKeyPair {
  const signing = generateSigningKeyPair()
  // Generate a separate X25519 key pair for DH operations
  // (Ed25519 → X25519 conversion exists but is subtle; separate keys are cleaner)
  const dh = generateDHKeyPair()
  return { signing, dh }
}

/**
 * Generate a signed pre-key. Signed by the identity's Ed25519 key
 * so recipients can verify it belongs to this identity.
 */
export function generateSignedPreKey(
  identitySigningKey: KeyPair,
  id: number
): SignedPreKey {
  const keyPair = generateDHKeyPair()
  const signature = ed25519.sign(keyPair.publicKey, identitySigningKey.privateKey)
  return { id, keyPair, signature }
}

/** Generate a batch of one-time pre-keys */
export function generateOneTimePreKeys(startId: number, count: number): OneTimePreKey[] {
  const keys: OneTimePreKey[] = []
  for (let i = 0; i < count; i++) {
    keys.push({ id: startId + i, keyPair: generateDHKeyPair() })
  }
  return keys
}

/**
 * Build a pre-key bundle for server upload.
 * Contains only public keys — private material stays on device.
 */
export function buildPreKeyBundle(
  identity: IdentityKeyPair,
  signedPreKey: SignedPreKey,
  oneTimePreKeys: OneTimePreKey[]
): PreKeyBundle {
  return {
    identityKey: identity.signing.publicKey,
    identityDHKey: identity.dh.publicKey,
    signedPreKey: {
      id: signedPreKey.id,
      publicKey: signedPreKey.keyPair.publicKey,
      signature: signedPreKey.signature
    },
    oneTimePreKeys: oneTimePreKeys.map((otpk) => ({
      id: otpk.id,
      publicKey: otpk.keyPair.publicKey
    }))
  }
}

// ---------------------------------------------------------------------------
//  X3DH Key Agreement
// ---------------------------------------------------------------------------

/**
 * Concatenate Uint8Arrays.
 */
function concat(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const arr of arrays) {
    result.set(arr, offset)
    offset += arr.length
  }
  return result
}

/**
 * Perform X3DH as the initiator (Alice).
 *
 * Fetches Bob's pre-key bundle from the server and computes a shared secret.
 * Bob does NOT need to be online — his bundle was uploaded ahead of time.
 *
 * DH calculations:
 *   DH1 = DH(IK_A, SPK_B)   — our identity DH key × their signed pre-key
 *   DH2 = DH(EK_A, IK_B)    — our ephemeral × their identity DH key
 *   DH3 = DH(EK_A, SPK_B)   — our ephemeral × their signed pre-key
 *   DH4 = DH(EK_A, OPK_B)   — our ephemeral × their one-time pre-key (optional)
 */
export function performX3DH(
  ourIdentity: IdentityKeyPair,
  theirBundle: PreKeyBundle,
  theirOneTimePreKey?: { id: number; publicKey: Uint8Array }
): X3DHResult {
  // Verify the signed pre-key signature
  const sigValid = ed25519.verify(
    theirBundle.signedPreKey.signature,
    theirBundle.signedPreKey.publicKey,
    theirBundle.identityKey
  )
  if (!sigValid) {
    throw new Error('X3DH: signed pre-key signature verification failed')
  }

  // Generate ephemeral key pair
  const ephemeral = generateDHKeyPair()

  // Perform DH calculations
  const dh1 = x25519.getSharedSecret(ourIdentity.dh.privateKey, theirBundle.signedPreKey.publicKey)
  const dh2 = x25519.getSharedSecret(ephemeral.privateKey, theirBundle.identityDHKey)
  const dh3 = x25519.getSharedSecret(ephemeral.privateKey, theirBundle.signedPreKey.publicKey)

  let dhConcat: Uint8Array
  let usedOneTimePreKeyId: number | null = null

  if (theirOneTimePreKey) {
    const dh4 = x25519.getSharedSecret(ephemeral.privateKey, theirOneTimePreKey.publicKey)
    dhConcat = concat(dh1, dh2, dh3, dh4)
    usedOneTimePreKeyId = theirOneTimePreKey.id
  } else {
    dhConcat = concat(dh1, dh2, dh3)
  }

  // Derive 32-byte shared secret via HKDF
  // Salt of 32 zero bytes per Signal spec
  const salt = new Uint8Array(32)
  const sharedSecret = hkdf(sha256, dhConcat, salt, X3DH_INFO, 32)

  return {
    sharedSecret,
    ephemeralPublicKey: ephemeral.publicKey,
    usedOneTimePreKeyId
  }
}

/**
 * Respond to X3DH as the recipient (Bob).
 *
 * Called when Bob receives Alice's initial message containing her
 * identity key and ephemeral key.
 */
export function respondX3DH(
  ourIdentity: IdentityKeyPair,
  ourSignedPreKey: SignedPreKey,
  ourOneTimePreKey: OneTimePreKey | null,
  theirIdentityDHKey: Uint8Array,
  theirEphemeralKey: Uint8Array
): Uint8Array {
  // Mirror Alice's DH calculations with our private keys
  const dh1 = x25519.getSharedSecret(ourSignedPreKey.keyPair.privateKey, theirIdentityDHKey)
  const dh2 = x25519.getSharedSecret(ourIdentity.dh.privateKey, theirEphemeralKey)
  const dh3 = x25519.getSharedSecret(ourSignedPreKey.keyPair.privateKey, theirEphemeralKey)

  let dhConcat: Uint8Array

  if (ourOneTimePreKey) {
    const dh4 = x25519.getSharedSecret(ourOneTimePreKey.keyPair.privateKey, theirEphemeralKey)
    dhConcat = concat(dh1, dh2, dh3, dh4)
  } else {
    dhConcat = concat(dh1, dh2, dh3)
  }

  const salt = new Uint8Array(32)
  return hkdf(sha256, dhConcat, salt, X3DH_INFO, 32)
}

// ---------------------------------------------------------------------------
//  Double Ratchet — KDF Chains
// ---------------------------------------------------------------------------

/**
 * KDF for the root chain. Takes the current root key and a DH output,
 * produces a new root key and a new chain key.
 *
 * Per Signal spec: HKDF with root key as salt, DH output as input.
 * Output is 64 bytes: first 32 = new root key, second 32 = new chain key.
 */
function kdfRootKey(
  rootKey: Uint8Array,
  dhOutput: Uint8Array
): { rootKey: Uint8Array; chainKey: Uint8Array } {
  const output = hkdf(sha256, dhOutput, rootKey, RATCHET_INFO, 64)
  return {
    rootKey: output.slice(0, 32),
    chainKey: output.slice(32, 64)
  }
}

/**
 * KDF for a chain key. Derives a message key and advances the chain.
 *
 * Per Signal spec:
 *   message key = HMAC-SHA256(chain_key, 0x01)
 *   next chain key = HMAC-SHA256(chain_key, 0x02)
 */
function kdfChainKey(chainKey: Uint8Array): { messageKey: Uint8Array; nextChainKey: Uint8Array } {
  const messageKey = hmac(sha256, chainKey, new Uint8Array([0x01]))
  const nextChainKey = hmac(sha256, chainKey, new Uint8Array([0x02]))
  return { messageKey, nextChainKey }
}

// ---------------------------------------------------------------------------
//  Double Ratchet — AES-256-GCM Encryption
// ---------------------------------------------------------------------------

/**
 * Encrypt plaintext with AES-256-GCM using a message key.
 * The message key is used via HKDF to derive a 32-byte AES key and a 12-byte nonce.
 */
async function aesEncrypt(
  messageKey: Uint8Array,
  plaintext: Uint8Array,
  associatedData: Uint8Array
): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
  // Derive AES key and nonce from message key
  const derived = hkdf(sha256, messageKey, new Uint8Array(32), new TextEncoder().encode('AES'), 44)
  const aesKeyBytes = derived.slice(0, 32)
  const nonce = derived.slice(32, 44)

  const aesKey = await crypto.subtle.importKey(
    'raw', asBufferSource(aesKeyBytes), { name: 'AES-GCM' }, false, ['encrypt']
  )

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asBufferSource(nonce), additionalData: asBufferSource(associatedData) },
    aesKey,
    asBufferSource(plaintext)
  )

  return { ciphertext: new Uint8Array(ciphertext), nonce }
}

/**
 * Decrypt ciphertext with AES-256-GCM using a message key.
 */
async function aesDecrypt(
  messageKey: Uint8Array,
  ciphertext: Uint8Array,
  associatedData: Uint8Array
): Promise<Uint8Array> {
  const derived = hkdf(sha256, messageKey, new Uint8Array(32), new TextEncoder().encode('AES'), 44)
  const aesKeyBytes = derived.slice(0, 32)
  const nonce = derived.slice(32, 44)

  const aesKey = await crypto.subtle.importKey(
    'raw', asBufferSource(aesKeyBytes), { name: 'AES-GCM' }, false, ['decrypt']
  )

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asBufferSource(nonce), additionalData: asBufferSource(associatedData) },
    aesKey,
    asBufferSource(ciphertext)
  )

  return new Uint8Array(plaintext)
}

// ---------------------------------------------------------------------------
//  Double Ratchet — Session Management
// ---------------------------------------------------------------------------

function skippedKeyId(publicKey: Uint8Array, counter: number): string {
  return bytesToHex(publicKey) + ':' + counter
}

/**
 * Initialize a Double Ratchet session as the initiator (Alice).
 *
 * Alice has already performed X3DH and has a shared secret.
 * She uses Bob's signed pre-key as the initial receiving DH key.
 */
export function initSessionAsInitiator(
  sharedSecret: Uint8Array,
  theirSignedPreKeyPublic: Uint8Array
): SessionState {
  // Generate our first ratchet key pair
  const dhSending = generateDHKeyPair()

  // Perform initial DH ratchet step
  const dhOutput = x25519.getSharedSecret(dhSending.privateKey, theirSignedPreKeyPublic)
  const { rootKey, chainKey } = kdfRootKey(sharedSecret, dhOutput)

  return {
    dhSending,
    dhReceiving: theirSignedPreKeyPublic,
    rootKey,
    chainKeySending: chainKey,
    chainKeyReceiving: null,
    sendingCounter: 0,
    receivingCounter: 0,
    previousChainLength: 0,
    skippedKeys: new Map()
  }
}

/**
 * Initialize a Double Ratchet session as the responder (Bob).
 *
 * Bob uses his signed pre-key as the initial DH key pair.
 * The sending chain isn't initialized yet — it will be created
 * on the first DH ratchet step when Bob sends a message.
 */
export function initSessionAsResponder(
  sharedSecret: Uint8Array,
  ourSignedPreKeyPair: KeyPair
): SessionState {
  return {
    dhSending: ourSignedPreKeyPair,
    dhReceiving: null,
    rootKey: sharedSecret,
    chainKeySending: null,
    chainKeyReceiving: null,
    sendingCounter: 0,
    receivingCounter: 0,
    previousChainLength: 0,
    skippedKeys: new Map()
  }
}

/**
 * Perform a DH ratchet step. Called when we receive a message with
 * a new ratchet public key from the remote party.
 */
function dhRatchetStep(session: SessionState, theirNewPublicKey: Uint8Array): void {
  // Save previous sending chain length
  session.previousChainLength = session.sendingCounter
  session.sendingCounter = 0
  session.receivingCounter = 0

  session.dhReceiving = theirNewPublicKey

  // Advance root key → new receiving chain
  const dhReceive = x25519.getSharedSecret(session.dhSending.privateKey, theirNewPublicKey)
  const receiveResult = kdfRootKey(session.rootKey, dhReceive)
  session.rootKey = receiveResult.rootKey
  session.chainKeyReceiving = receiveResult.chainKey

  // Generate new sending key pair
  session.dhSending = generateDHKeyPair()

  // Advance root key → new sending chain
  const dhSend = x25519.getSharedSecret(session.dhSending.privateKey, theirNewPublicKey)
  const sendResult = kdfRootKey(session.rootKey, dhSend)
  session.rootKey = sendResult.rootKey
  session.chainKeySending = sendResult.chainKey
}

/**
 * Store skipped message keys when the remote party has sent messages
 * we haven't received yet (out-of-order delivery).
 */
function skipMessageKeys(session: SessionState, until: number): void {
  if (session.chainKeyReceiving === null) return

  if (until - session.receivingCounter > MAX_SKIP) {
    throw new Error(`Cannot skip more than ${MAX_SKIP} message keys`)
  }

  while (session.receivingCounter < until) {
    const { messageKey, nextChainKey } = kdfChainKey(session.chainKeyReceiving)
    const id = skippedKeyId(session.dhReceiving!, session.receivingCounter)
    session.skippedKeys.set(id, messageKey)
    session.chainKeyReceiving = nextChainKey
    session.receivingCounter++

    // Evict oldest if over limit
    if (session.skippedKeys.size > MAX_SKIP) {
      const firstKey = session.skippedKeys.keys().next().value
      if (firstKey !== undefined) session.skippedKeys.delete(firstKey)
    }
  }
}

/**
 * Encode a message header as associated data for AEAD.
 */
function encodeHeader(header: MessageHeader): Uint8Array {
  // Format: [32 bytes pubkey][4 bytes PN][4 bytes N]
  const ad = new Uint8Array(40)
  ad.set(header.publicKey, 0)
  new DataView(ad.buffer).setUint32(32, header.previousChainLength, false)
  new DataView(ad.buffer).setUint32(36, header.messageNumber, false)
  return ad
}

/**
 * Encrypt a message using the Double Ratchet.
 *
 * Returns the encrypted message and the updated session state.
 * The caller must persist the new session state.
 */
export async function ratchetEncrypt(
  session: SessionState,
  plaintext: Uint8Array
): Promise<{ message: EncryptedMessage; session: SessionState }> {
  // Clone session to avoid mutation
  const newSession = cloneSession(session)

  if (newSession.chainKeySending === null) {
    throw new Error('Sending chain not initialized')
  }

  // Derive message key from sending chain
  const { messageKey, nextChainKey } = kdfChainKey(newSession.chainKeySending)
  newSession.chainKeySending = nextChainKey

  const header: MessageHeader = {
    publicKey: newSession.dhSending.publicKey,
    previousChainLength: newSession.previousChainLength,
    messageNumber: newSession.sendingCounter
  }
  newSession.sendingCounter++

  const ad = encodeHeader(header)
  const { ciphertext } = await aesEncrypt(messageKey, plaintext, ad)

  return {
    message: { header, ciphertext },
    session: newSession
  }
}

/**
 * Decrypt a message using the Double Ratchet.
 *
 * Handles DH ratchet steps and out-of-order messages automatically.
 * Returns null if decryption fails (e.g., corrupted or tampered message).
 */
export async function ratchetDecrypt(
  session: SessionState,
  message: EncryptedMessage
): Promise<{ plaintext: Uint8Array; session: SessionState } | null> {
  const newSession = cloneSession(session)
  const ad = encodeHeader(message.header)

  // Check skipped keys first (out-of-order message)
  const skippedId = skippedKeyId(message.header.publicKey, message.header.messageNumber)
  const skippedKey = newSession.skippedKeys.get(skippedId)
  if (skippedKey) {
    newSession.skippedKeys.delete(skippedId)
    try {
      const plaintext = await aesDecrypt(skippedKey, message.ciphertext, ad)
      return { plaintext, session: newSession }
    } catch {
      return null
    }
  }

  // Is this a new DH ratchet key?
  const isNewRatchetKey = newSession.dhReceiving === null ||
    !uint8ArrayEquals(message.header.publicKey, newSession.dhReceiving)

  if (isNewRatchetKey) {
    // Skip any remaining messages in the current receiving chain
    if (newSession.dhReceiving !== null && newSession.chainKeyReceiving !== null) {
      skipMessageKeys(newSession, message.header.previousChainLength)
    }
    // Perform DH ratchet step
    dhRatchetStep(newSession, message.header.publicKey)
  }

  // Skip ahead to the message number in this chain
  skipMessageKeys(newSession, message.header.messageNumber)

  if (newSession.chainKeyReceiving === null) {
    return null
  }

  // Derive the message key for this message
  const { messageKey, nextChainKey } = kdfChainKey(newSession.chainKeyReceiving)
  newSession.chainKeyReceiving = nextChainKey
  newSession.receivingCounter++

  try {
    const plaintext = await aesDecrypt(messageKey, message.ciphertext, ad)
    return { plaintext, session: newSession }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
//  Sender Keys — Group Messaging
// ---------------------------------------------------------------------------

/**
 * Generate a new Sender Key for group messaging.
 *
 * Each group member generates their own sender key and distributes it
 * to other members via their pairwise Double Ratchet sessions.
 */
export function generateSenderKey(): SenderKeyState {
  return {
    chainKey: randomBytes(32),
    signingKey: generateSigningKeyPair(),
    iteration: 0
  }
}

/**
 * Encrypt a group message using a Sender Key.
 *
 * The sender key chain ratchets forward after each message (forward secrecy).
 * The message is signed with the sender's signing key for authentication.
 */
export async function senderKeyEncrypt(
  state: SenderKeyState,
  plaintext: Uint8Array
): Promise<{
  ciphertext: Uint8Array
  signature: Uint8Array
  iteration: number
  state: SenderKeyState
}> {
  // Derive message key from chain key
  const { messageKey, nextChainKey } = kdfChainKey(state.chainKey)

  // Encrypt with AES-256-GCM
  // Associated data includes the iteration counter for ordering
  const iterBytes = new Uint8Array(4)
  new DataView(iterBytes.buffer).setUint32(0, state.iteration, false)
  const { ciphertext, nonce } = await aesEncrypt(messageKey, plaintext, iterBytes)

  // Combine nonce + ciphertext for transport
  const payload = concat(nonce, ciphertext)

  // Sign the payload for authentication
  const signature = ed25519.sign(payload, state.signingKey.privateKey)

  const newState: SenderKeyState = {
    chainKey: nextChainKey,
    signingKey: state.signingKey,
    iteration: state.iteration + 1
  }

  return {
    ciphertext: payload,
    signature,
    iteration: state.iteration,
    state: newState
  }
}

/**
 * Decrypt a group message using a received Sender Key.
 *
 * Verifies the signature and ratchets the receiver's copy of the chain
 * forward to the correct iteration. Stores skipped message keys so
 * out-of-order messages that arrive late can still be decrypted.
 */
export async function senderKeyDecrypt(
  receiver: SenderKeyReceiver,
  ciphertext: Uint8Array,
  signature: Uint8Array,
  iteration: number
): Promise<{ plaintext: Uint8Array; receiver: SenderKeyReceiver } | null> {
  // Verify signature
  if (!ed25519.verify(signature, ciphertext, receiver.signingPublicKey)) {
    return null
  }

  // Clone skippedKeys to avoid mutating the original receiver on failure
  const newSkippedKeys = new Map(
    Array.from(receiver.skippedKeys.entries()).map(([k, v]) => [k, new Uint8Array(v)])
  )

  // Check skipped keys first (out-of-order message that arrived after a later one)
  const skippedKey = newSkippedKeys.get(iteration)
  if (skippedKey !== undefined) {
    newSkippedKeys.delete(iteration)
    const rawCiphertext = ciphertext.slice(12)
    const iterBytes = new Uint8Array(4)
    new DataView(iterBytes.buffer).setUint32(0, iteration, false)
    try {
      const plaintext = await aesDecrypt(skippedKey, rawCiphertext, iterBytes)
      const newReceiver: SenderKeyReceiver = {
        chainKey: new Uint8Array(receiver.chainKey),
        signingPublicKey: receiver.signingPublicKey,
        iteration: receiver.iteration,
        skippedKeys: newSkippedKeys
      }
      return { plaintext, receiver: newReceiver }
    } catch {
      return null
    }
  }

  // Message is truly in the past and not cached — permanently lost
  if (iteration < receiver.iteration) {
    return null
  }

  // Refuse to skip too far ahead (guards against memory exhaustion)
  const skip = iteration - receiver.iteration
  if (skip > MAX_SKIP) {
    return null
  }

  // Advance chain key forward, caching each skipped message key
  let chainKey = receiver.chainKey
  let currentIter = receiver.iteration

  for (let i = 0; i < skip; i++) {
    const { messageKey, nextChainKey } = kdfChainKey(chainKey)
    newSkippedKeys.set(currentIter, messageKey)
    chainKey = nextChainKey
    currentIter++
  }

  // Evict oldest entries if cache exceeds limit
  while (newSkippedKeys.size > MAX_SKIP) {
    const firstKey = newSkippedKeys.keys().next().value
    if (firstKey !== undefined) newSkippedKeys.delete(firstKey)
  }

  // Derive message key at the target iteration
  const { messageKey, nextChainKey } = kdfChainKey(chainKey)

  // Strip the 12-byte nonce prefix (payload format from senderKeyEncrypt: nonce || ciphertext)
  // aesDecrypt re-derives the nonce deterministically from the message key, so we pass raw ciphertext
  const rawCiphertext = ciphertext.slice(12)

  const iterBytes = new Uint8Array(4)
  new DataView(iterBytes.buffer).setUint32(0, iteration, false)

  try {
    const plaintext = await aesDecrypt(messageKey, rawCiphertext, iterBytes)

    const newReceiver: SenderKeyReceiver = {
      chainKey: nextChainKey,
      signingPublicKey: receiver.signingPublicKey,
      iteration: currentIter + 1,
      skippedKeys: newSkippedKeys
    }

    return { plaintext, receiver: newReceiver }
  } catch {
    return null
  }
}

/**
 * Create a receiver-side copy of a sender key.
 * Called after receiving a sender key distribution via pairwise session.
 */
export function createSenderKeyReceiver(
  chainKey: Uint8Array,
  signingPublicKey: Uint8Array,
  iteration: number = 0
): SenderKeyReceiver {
  return {
    chainKey: new Uint8Array(chainKey),
    signingPublicKey: new Uint8Array(signingPublicKey),
    iteration,
    skippedKeys: new Map()
  }
}

// ---------------------------------------------------------------------------
//  Voice Key Derivation
// ---------------------------------------------------------------------------

/**
 * Derive a 128-bit AES key for voice E2EE from a group shared secret.
 *
 * For DMs: the shared secret is derived from the pairwise session's root key.
 * For groups: derived from a hash of all current sender keys.
 */
export function deriveVoiceKey(sharedSecret: Uint8Array): Uint8Array {
  return hkdf(sha256, sharedSecret, new Uint8Array(16), VOICE_KEY_INFO, 16)
}

// ---------------------------------------------------------------------------
//  Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a Double Ratchet session for persistent storage.
 * Format: JSON with Uint8Arrays encoded as hex strings.
 */
export function serializeSession(session: SessionState): Uint8Array {
  const obj = {
    v: 1, // version
    dhs: {
      priv: bytesToHex(session.dhSending.privateKey),
      pub: bytesToHex(session.dhSending.publicKey)
    },
    dhr: session.dhReceiving ? bytesToHex(session.dhReceiving) : null,
    rk: bytesToHex(session.rootKey),
    cks: session.chainKeySending ? bytesToHex(session.chainKeySending) : null,
    ckr: session.chainKeyReceiving ? bytesToHex(session.chainKeyReceiving) : null,
    ns: session.sendingCounter,
    nr: session.receivingCounter,
    pn: session.previousChainLength,
    skip: Object.fromEntries(
      Array.from(session.skippedKeys.entries()).map(([k, v]) => [k, bytesToHex(v)])
    )
  }

  return new TextEncoder().encode(JSON.stringify(obj))
}

/** Deserialize a Double Ratchet session from storage. */
export function deserializeSession(bytes: Uint8Array): SessionState {
  const obj = JSON.parse(new TextDecoder().decode(bytes))
  if (obj.v !== 1) throw new Error(`Unknown session format version: ${obj.v}`)

  return {
    dhSending: {
      privateKey: hexToBytes(obj.dhs.priv),
      publicKey: hexToBytes(obj.dhs.pub)
    },
    dhReceiving: obj.dhr ? hexToBytes(obj.dhr) : null,
    rootKey: hexToBytes(obj.rk),
    chainKeySending: obj.cks ? hexToBytes(obj.cks) : null,
    chainKeyReceiving: obj.ckr ? hexToBytes(obj.ckr) : null,
    sendingCounter: obj.ns,
    receivingCounter: obj.nr,
    previousChainLength: obj.pn,
    skippedKeys: new Map(
      Object.entries(obj.skip as Record<string, string>).map(([k, v]) => [k, hexToBytes(v)])
    )
  }
}

/** Serialize a sender key state for storage. */
export function serializeSenderKey(state: SenderKeyState): Uint8Array {
  const obj = {
    v: 1,
    ck: bytesToHex(state.chainKey),
    sk: {
      priv: bytesToHex(state.signingKey.privateKey),
      pub: bytesToHex(state.signingKey.publicKey)
    },
    iter: state.iteration
  }
  return new TextEncoder().encode(JSON.stringify(obj))
}

/** Deserialize a sender key state from storage. */
export function deserializeSenderKey(bytes: Uint8Array): SenderKeyState {
  const obj = JSON.parse(new TextDecoder().decode(bytes))
  if (obj.v !== 1) throw new Error(`Unknown sender key format version: ${obj.v}`)

  return {
    chainKey: hexToBytes(obj.ck),
    signingKey: {
      privateKey: hexToBytes(obj.sk.priv),
      publicKey: hexToBytes(obj.sk.pub)
    },
    iteration: obj.iter
  }
}

/** Serialize a sender key receiver state for storage. */
export function serializeSenderKeyReceiver(receiver: SenderKeyReceiver): Uint8Array {
  const obj = {
    v: 1,
    ck: bytesToHex(receiver.chainKey),
    spk: bytesToHex(receiver.signingPublicKey),
    iter: receiver.iteration,
    skip: Object.fromEntries(
      Array.from(receiver.skippedKeys.entries()).map(([k, v]) => [k.toString(), bytesToHex(v)])
    )
  }
  return new TextEncoder().encode(JSON.stringify(obj))
}

/** Deserialize a sender key receiver state from storage. */
export function deserializeSenderKeyReceiver(bytes: Uint8Array): SenderKeyReceiver {
  const obj = JSON.parse(new TextDecoder().decode(bytes))
  if (obj.v !== 1) throw new Error(`Unknown sender key receiver format version: ${obj.v}`)

  return {
    chainKey: hexToBytes(obj.ck),
    signingPublicKey: hexToBytes(obj.spk),
    iteration: obj.iter,
    skippedKeys: new Map(
      Object.entries((obj.skip ?? {}) as Record<string, string>).map(([k, v]) => [parseInt(k), hexToBytes(v)])
    )
  }
}

/**
 * Encode a pre-key bundle for wire transport (binary format).
 *
 * Format:
 *   [1 byte version = 0x01]
 *   [32 bytes identity key]
 *   [32 bytes identity DH key]
 *   [4 bytes signed pre-key ID]
 *   [32 bytes signed pre-key public]
 *   [64 bytes signed pre-key signature]
 *   [2 bytes one-time pre-key count]
 *   For each OPK:
 *     [4 bytes OPK ID]
 *     [32 bytes OPK public]
 */
export function encodePreKeyBundle(bundle: PreKeyBundle): Uint8Array {
  const opkCount = bundle.oneTimePreKeys.length
  const size = 1 + 32 + 32 + 4 + 32 + 64 + 2 + opkCount * 36
  const buf = new Uint8Array(size)
  const view = new DataView(buf.buffer)
  let offset = 0

  buf[offset++] = 0x01 // version
  buf.set(bundle.identityKey, offset); offset += 32
  buf.set(bundle.identityDHKey, offset); offset += 32
  view.setUint32(offset, bundle.signedPreKey.id, false); offset += 4
  buf.set(bundle.signedPreKey.publicKey, offset); offset += 32
  buf.set(bundle.signedPreKey.signature, offset); offset += 64
  view.setUint16(offset, opkCount, false); offset += 2

  for (const opk of bundle.oneTimePreKeys) {
    view.setUint32(offset, opk.id, false); offset += 4
    buf.set(opk.publicKey, offset); offset += 32
  }

  return buf
}

/** Decode a pre-key bundle from wire format. */
export function decodePreKeyBundle(buf: Uint8Array): PreKeyBundle {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let offset = 0

  const version = buf[offset++]
  if (version !== 0x01) throw new Error(`Unknown pre-key bundle version: ${version}`)

  const identityKey = buf.slice(offset, offset + 32); offset += 32
  const identityDHKey = buf.slice(offset, offset + 32); offset += 32
  const spkId = view.getUint32(offset, false); offset += 4
  const spkPublic = buf.slice(offset, offset + 32); offset += 32
  const spkSig = buf.slice(offset, offset + 64); offset += 64
  const opkCount = view.getUint16(offset, false); offset += 2

  const oneTimePreKeys: Array<{ id: number; publicKey: Uint8Array }> = []
  for (let i = 0; i < opkCount; i++) {
    const id = view.getUint32(offset, false); offset += 4
    const publicKey = buf.slice(offset, offset + 32); offset += 32
    oneTimePreKeys.push({ id, publicKey })
  }

  return {
    identityKey,
    identityDHKey,
    signedPreKey: { id: spkId, publicKey: spkPublic, signature: spkSig },
    oneTimePreKeys
  }
}

/**
 * Encode an encrypted message for wire transport.
 *
 * Format:
 *   [1 byte version = 0x01]
 *   [32 bytes header public key]
 *   [4 bytes previous chain length]
 *   [4 bytes message number]
 *   [4 bytes ciphertext length]
 *   [N bytes ciphertext]
 */
export function encodeMessage(message: EncryptedMessage): Uint8Array {
  const size = 1 + 32 + 4 + 4 + 4 + message.ciphertext.length
  const buf = new Uint8Array(size)
  const view = new DataView(buf.buffer)
  let offset = 0

  buf[offset++] = 0x01
  buf.set(message.header.publicKey, offset); offset += 32
  view.setUint32(offset, message.header.previousChainLength, false); offset += 4
  view.setUint32(offset, message.header.messageNumber, false); offset += 4
  view.setUint32(offset, message.ciphertext.length, false); offset += 4
  buf.set(message.ciphertext, offset)

  return buf
}

/** Decode an encrypted message from wire format. */
export function decodeMessage(buf: Uint8Array): EncryptedMessage {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let offset = 0

  const version = buf[offset++]
  if (version !== 0x01) throw new Error(`Unknown message version: ${version}`)

  const publicKey = buf.slice(offset, offset + 32); offset += 32
  const previousChainLength = view.getUint32(offset, false); offset += 4
  const messageNumber = view.getUint32(offset, false); offset += 4
  const ctLen = view.getUint32(offset, false); offset += 4
  const ciphertext = buf.slice(offset, offset + ctLen)

  return {
    header: { publicKey, previousChainLength, messageNumber },
    ciphertext,
  }
}

// ---------------------------------------------------------------------------
//  Utilities
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function uint8ArrayEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function cloneSession(session: SessionState): SessionState {
  return {
    dhSending: {
      privateKey: new Uint8Array(session.dhSending.privateKey),
      publicKey: new Uint8Array(session.dhSending.publicKey)
    },
    dhReceiving: session.dhReceiving ? new Uint8Array(session.dhReceiving) : null,
    rootKey: new Uint8Array(session.rootKey),
    chainKeySending: session.chainKeySending ? new Uint8Array(session.chainKeySending) : null,
    chainKeyReceiving: session.chainKeyReceiving ? new Uint8Array(session.chainKeyReceiving) : null,
    sendingCounter: session.sendingCounter,
    receivingCounter: session.receivingCounter,
    previousChainLength: session.previousChainLength,
    skippedKeys: new Map(
      Array.from(session.skippedKeys.entries()).map(([k, v]) => [k, new Uint8Array(v)])
    )
  }
}
