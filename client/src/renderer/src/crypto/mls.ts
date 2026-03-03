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
  type CiphersuiteImpl,
  type ClientState,
  type KeyPackage,
  type PrivateKeyPackage,
  type Proposal,
  type MLSMessage
} from 'ts-mls'
import type { KeyPackagePair } from './types'

const CIPHERSUITE_NAME = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const

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
  return createGroup(groupIdBytes, keyPackage, privateKeyPackage, [], cs)
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
  const decoded = decodeMlsMessage(welcomeBytes)

  if (decoded.wireformat !== 'mls_welcome') {
    throw new Error(`Expected mls_welcome, got ${decoded.wireformat}`)
  }

  const pskIndex = makePskIndex(undefined, {})
  return joinGroup(decoded.welcome, keyPackage, privateKeys, pskIndex, cs)
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
  const decoded = decodeMlsMessage(commitBytes)

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
 */
export async function decryptMessage(
  state: ClientState,
  ciphertext: Uint8Array
): Promise<{
  plaintext: string
  newState: ClientState
} | null> {
  const cs = getCs()
  const decoded = decodeMlsMessage(ciphertext)

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
  return decodeGroupState(bytes)
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
  const decoded = decodeMlsMessage(bytes)
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
