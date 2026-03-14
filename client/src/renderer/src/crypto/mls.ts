import {
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  generateKeyPackage,
  generateKeyPackageWithKey,
  defaultCapabilities,
  defaultLifetime,
  createGroup,
  createCommit,
  joinGroup,
  createApplicationMessage,
  processMessage,
  processPrivateMessage,
  encodeMlsMessage,
  decodeMlsMessage,
  encodeGroupState,
  decodeGroupState,
  makePskIndex,
  mlsExporter,
  defaultKeyRetentionConfig,
  defaultLifetimeConfig,
  defaultPaddingConfig,
  defaultKeyPackageEqualityConfig,
  defaultAuthenticationService,
  type CiphersuiteImpl,
  type ClientState,
  type ClientConfig,
  type KeyPackage,
  type PrivateKeyPackage,
  type Proposal,
  type MLSMessage
} from 'ts-mls'
import type { KeyPackagePair } from './types'

/**
 * Properly decode an MLS message from bytes.
 *
 * ts-mls's `decodeMlsMessage` is a raw TLS decoder with the signature
 * `(buf: Uint8Array, offset: number) => [MLSMessage, bytesConsumed] | undefined`.
 * It must be called with an explicit offset (0 for top-level decoding) and
 * returns a `[value, length]` tuple — not the decoded value directly.
 *
 * Calling it without the offset argument leaves `offset` as `undefined`,
 * which corrupts the internal accumulator (`undefined + 2 = NaN`) so every
 * sub-decoder after the first reads from byte 0, producing garbage.
 */
function decodeMlsMessageFromBytes(bytes: Uint8Array): MLSMessage {
  const result = decodeMlsMessage(bytes, 0)
  if (!result) {
    throw new Error('Failed to decode MLS message: decoder returned undefined')
  }
  // decodeMlsMessage returns [decodedValue, bytesConsumed]
  return result[0] as MLSMessage
}

const CIPHERSUITE_NAME = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const

/**
 * Epoch key retention depth. Controls how many past epochs' decryption keys
 * are kept in the serialized ClientState, enabling decryption of messages
 * from older epochs. The ts-mls default is 4; we raise it to 64 so cached
 * messages remain decryptable across a reasonable window of group updates.
 */
const RETAIN_KEYS_FOR_EPOCHS = 64

const vesperClientConfig: ClientConfig = {
  keyRetentionConfig: {
    ...defaultKeyRetentionConfig,
    retainKeysForEpochs: RETAIN_KEYS_FOR_EPOCHS
  },
  lifetimeConfig: defaultLifetimeConfig,
  keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
  paddingConfig: defaultPaddingConfig,
  authService: defaultAuthenticationService
}

let csImpl: CiphersuiteImpl | null = null

/**
 * Initialize the cipher suite. Must be called before any MLS operations.
 */
export async function initCipherSuite(): Promise<CiphersuiteImpl> {
  if (csImpl) return csImpl
  const cs = getCiphersuiteFromName(CIPHERSUITE_NAME)
  csImpl = await getCiphersuiteImpl(cs)
  return csImpl
}

function getCs(): CiphersuiteImpl {
  if (!csImpl) throw new Error('Cipher suite not initialized. Call initCipherSuite() first.')
  return csImpl
}

/**
 * Create a basic MLS credential from a user ID.
 */
function makeCredential(userId: string) {
  return {
    credentialType: 'basic' as const,
    identity: new TextEncoder().encode(userId)
  }
}

/**
 * Generate a batch of key packages for a user.
 * Returns public packages (for server) and private packages (for local storage).
 */
export async function createKeyPackageBatch(
  userId: string,
  count: number,
  signatureKeyPair?: { signKey: Uint8Array; publicKey: Uint8Array }
): Promise<KeyPackagePair[]> {
  const cs = getCs()
  const credential = makeCredential(userId)
  const capabilities = defaultCapabilities()
  const lifetime = defaultLifetime

  const pairs: KeyPackagePair[] = []
  for (let i = 0; i < count; i++) {
    const result = signatureKeyPair
      ? await generateKeyPackageWithKey(
          credential,
          capabilities,
          lifetime,
          [],
          signatureKeyPair,
          cs
        )
      : await generateKeyPackage(credential, capabilities, lifetime, [], cs)

    pairs.push({
      publicPackage: result.publicPackage,
      privatePackage: result.privatePackage
    })
  }

  return pairs
}

/**
 * Create a new MLS group. The creator is automatically the first member.
 */
export async function createMLSGroup(
  groupId: string,
  keyPackage: KeyPackage,
  privateKeyPackage: PrivateKeyPackage
): Promise<ClientState> {
  const cs = getCs()
  const groupIdBytes = new TextEncoder().encode(groupId)
  return createGroup(groupIdBytes, keyPackage, privateKeyPackage, [], cs, vesperClientConfig)
}

/**
 * Add a member to an existing MLS group.
 * Returns updated state, commit message, and welcome for the new member.
 */
export async function addMemberToGroup(
  state: ClientState,
  memberKeyPackage: KeyPackage
): Promise<{
  newState: ClientState
  commitBytes: Uint8Array
  welcomeBytes: Uint8Array | null
}> {
  const cs = getCs()
  const addProposal: Proposal = {
    proposalType: 'add',
    add: { keyPackage: memberKeyPackage }
  }

  const result = await createCommit(
    { state, cipherSuite: cs },
    {
      extraProposals: [addProposal],
      ratchetTreeExtension: true,
      wireAsPublicMessage: true
    }
  )

  const commitBytes = encodeMlsMessage(result.commit)
  let welcomeBytes: Uint8Array | null = null

  if (result.welcome) {
    const welcomeMsg: MLSMessage = {
      version: 'mls10',
      wireformat: 'mls_welcome',
      welcome: result.welcome
    }
    welcomeBytes = encodeMlsMessage(welcomeMsg)
  }

  return { newState: result.newState, commitBytes, welcomeBytes }
}

/**
 * Remove a member from an MLS group.
 */
export async function removeMemberFromGroup(
  state: ClientState,
  leafIndex: number
): Promise<{
  newState: ClientState
  commitBytes: Uint8Array
}> {
  const cs = getCs()
  const removeProposal: Proposal = {
    proposalType: 'remove',
    remove: { removed: leafIndex }
  }

  const result = await createCommit(
    { state, cipherSuite: cs },
    { extraProposals: [removeProposal], wireAsPublicMessage: true }
  )

  return {
    newState: result.newState,
    commitBytes: encodeMlsMessage(result.commit)
  }
}

/**
 * Process a Welcome message to join an existing MLS group.
 */
export async function processWelcome(
  welcomeBytes: Uint8Array,
  keyPackage: KeyPackage,
  privateKeys: PrivateKeyPackage
): Promise<ClientState> {
  const cs = getCs()
  const decoded = decodeMlsMessageFromBytes(welcomeBytes)

  if (decoded.wireformat !== 'mls_welcome') {
    throw new Error(`Expected mls_welcome, got ${decoded.wireformat}`)
  }

  const pskIndex = makePskIndex(undefined, {})
  return joinGroup(decoded.welcome, keyPackage, privateKeys, pskIndex, cs, undefined, undefined, vesperClientConfig)
}

/**
 * Process a commit message (from another member's Add/Remove/Update).
 * Updates local state to the new epoch.
 */
export async function processCommitMessage(
  state: ClientState,
  commitBytes: Uint8Array
): Promise<ClientState> {
  const cs = getCs()
  const decoded = decodeMlsMessageFromBytes(commitBytes)

  if (decoded.wireformat === 'mls_public_message') {
    const pskIndex = makePskIndex(state, {})
    const result = await processMessage(state, decoded, pskIndex, cs)
    if (result.kind === 'newState') {
      return result.newState
    }
    throw new Error(`Unexpected process result kind: ${result.kind}`)
  }

  throw new Error(`Expected public message for commit, got ${decoded.wireformat}`)
}

/**
 * Encrypt a plaintext message for the MLS group.
 */
export async function encryptMessage(
  state: ClientState,
  plaintext: string
): Promise<{
  ciphertext: Uint8Array
  epoch: number
  newState: ClientState
}> {
  const cs = getCs()
  const plaintextBytes = new TextEncoder().encode(plaintext)
  const result = await createApplicationMessage(state, plaintextBytes, cs)

  const mlsMsg: MLSMessage = {
    version: 'mls10',
    wireformat: 'mls_private_message',
    privateMessage: result.privateMessage
  }

  return {
    ciphertext: encodeMlsMessage(mlsMsg),
    epoch: Number(state.groupContext.epoch),
    newState: result.newState
  }
}

/**
 * Decrypt a ciphertext message from the MLS group.
 *
 * AUDIT NOTE (Phase 6.3 — MLS sender authentication):
 * ts-mls performs Ed25519 signature verification during processPrivateMessage().
 * The path is: processPrivateMessage → unprotectPrivateMessage (messageProtection.js)
 * which extracts the sender's signature public key from the ratchet tree via
 * getSignaturePublicKeyFromLeafIndex(), then calls verifyFramedContentSignature().
 * If the signature is invalid, it throws CryptoVerificationError("Signature invalid").
 * This means every decrypted message is authenticated against the sender's leaf node
 * key — a forged or tampered message will fail decryption entirely.
 */
export async function decryptMessage(
  state: ClientState,
  ciphertext: Uint8Array
): Promise<{
  plaintext: string
  newState: ClientState
} | null> {
  const cs = getCs()
  const decoded = decodeMlsMessageFromBytes(ciphertext)

  if (decoded.wireformat !== 'mls_private_message') {
    throw new Error(`Expected mls_private_message, got ${decoded.wireformat}`)
  }

  const pskIndex = makePskIndex(state, {})

  try {
    const result = await processPrivateMessage(
      state,
      decoded.privateMessage,
      pskIndex,
      cs
    )

    if (result.kind === 'applicationMessage') {
      return {
        plaintext: new TextDecoder().decode(result.message),
        newState: result.newState
      }
    }

    // Commit or proposal — return new state but no message content
    if (result.kind === 'newState') {
      return { plaintext: '', newState: result.newState }
    }

    return null
  } catch {
    // Decryption failed — message from before we joined, or corrupted
    return null
  }
}

/**
 * Serialize MLS group state for local storage.
 */
export function serializeGroupState(state: ClientState): Uint8Array {
  return encodeGroupState(state)
}

/**
 * Deserialize MLS group state from local storage.
 */
export function deserializeGroupState(bytes: Uint8Array): ClientState {
  const result = decodeGroupState(bytes, 0)
  if (!result) {
    throw new Error('Failed to decode group state: decoder returned undefined')
  }
  // decodeGroupState returns [decodedValue, bytesConsumed]
  return result[0] as ClientState
}

/**
 * Derive a 128-bit voice encryption key from the MLS group's exporter secret.
 * Uses the MLS exporter with label "voice-e2ee" and empty context.
 */
export async function deriveVoiceKey(state: ClientState): Promise<Uint8Array> {
  const cs = getCs()
  const context = new Uint8Array(0)
  return mlsExporter(state.keySchedule.exporterSecret, 'voice-e2ee', context, 16, cs)
}

/**
 * Decode a KeyPackage from its serialized form.
 */
export function decodeKeyPackageBytes(bytes: Uint8Array): KeyPackage {
  const decoded = decodeMlsMessageFromBytes(bytes)
  if (decoded.wireformat !== 'mls_key_package') {
    throw new Error(`Expected mls_key_package, got ${decoded.wireformat}`)
  }
  return decoded.keyPackage
}

/**
 * Encode a KeyPackage to bytes for transmission.
 */
export function encodeKeyPackageBytes(keyPackage: KeyPackage): Uint8Array {
  return encodeMlsMessage({
    version: 'mls10',
    wireformat: 'mls_key_package',
    keyPackage
  })
}
