/**
 * MLS wrapper for Vesper — OpenMLS WASM implementation
 *
 * Replaces ts-mls with OpenMLS (Rust → WASM), providing:
 * - Full RFC 9420 compliance including External Commits (§12.4)
 * - Formally audited cryptography (Cryspen)
 * - No decoder offset bugs, no clientConfig serialization issues
 * - External Commits: new members self-join via published GroupInfo
 *
 * This module maintains the same exported API as the ts-mls version
 * so encryptedChat.ts requires minimal changes.
 */

import initWasm, {
  Provider,
  Identity,
  Group,
  KeyPackage as WasmKeyPackage,
  RatchetTree,
  type ExternalCommitResult,
  type CommitBundle,
  type ProcessResult
} from 'vesper-openmls-wasm'

// Re-export WASM types that the orchestration layer needs
export type { ExternalCommitResult, CommitBundle, ProcessResult }
export { Provider, Identity, WasmKeyPackage as KeyPackage }

// ============================================================
// Types (replaces ts-mls type imports)
// ============================================================

/**
 * Opaque group state handle. Internally backed by OpenMLS Group + Provider + Identity.
 * Serializable via serializeGroupState / deserializeGroupState.
 */
export interface GroupState {
  /** The Provider holding all crypto state for this group */
  readonly _provider: Provider
  /** The Identity (credential + signing key) of the local user in this group */
  readonly _identity: Identity
  /** The active MLS Group */
  readonly _group: Group
  /** Epoch number — replaces state.groupContext.epoch from ts-mls */
  readonly groupContext: { readonly epoch: bigint }
}

/**
 * Serialized key package pair — public portion goes to server, private stays local.
 * With OpenMLS, the Provider's storage holds the private state.
 */
export interface KeyPackagePair {
  publicPackage: WasmKeyPackage
  privatePackage: Uint8Array // serialized identity for this key package's provider
}

// ============================================================
// Initialization
// ============================================================

let wasmInitialized = false

/**
 * Initialize the MLS cipher suite. Must be called before any MLS operations.
 * With OpenMLS, this loads the WASM module.
 *
 * @param wasmSource Optional WASM module source. Can be:
 *   - URL or string: fetched via the default loader
 *   - BufferSource: raw WASM bytes
 *   - undefined: auto-detected (fs in Node.js, import.meta.url in browser)
 */
export async function initCipherSuite(wasmSource?: string | URL | BufferSource): Promise<void> {
  if (wasmInitialized) return

  if (wasmSource) {
    await initWasm(wasmSource)
  } else if (typeof process !== 'undefined' && process.versions?.node) {
    // Node.js: load from disk
    const { readFile } = await import('fs/promises')
    const { fileURLToPath } = await import('url')
    const { dirname, join } = await import('path')

    const jsPath = fileURLToPath(import.meta.resolve('vesper-openmls-wasm'))
    const pkgDir = dirname(jsPath)
    const wasmPath = join(pkgDir, 'vesper_openmls_wasm_bg.wasm')
    const wasmBytes = await readFile(wasmPath)

    await initWasm(wasmBytes)
  } else {
    // Browser/Electron: try well-known URL first, fall back to default loader
    try {
      // Try loading from a well-known path (set up by the Vite WASM plugin)
      const wasmUrl = new URL('/assets/vesper_openmls_wasm_bg.wasm', window.location.origin)
      const response = await fetch(wasmUrl)
      if (response.ok) {
        await initWasm(await response.arrayBuffer())
      } else {
        // Fall back to default import.meta.url-based loader
        await initWasm()
      }
    } catch {
      // Last resort: default loader
      await initWasm()
    }
  }

  wasmInitialized = true
}

// ============================================================
// Identity helpers
// ============================================================

const MLS_IDENTITY_SEPARATOR = ':'

/**
 * Build a client credential identity string from userId and deviceId.
 */
export function buildClientCredentialIdentity(userId: string, deviceId: string): string {
  return `${userId}${MLS_IDENTITY_SEPARATOR}${deviceId}`
}

// ============================================================
// Key Package Management
// ============================================================

/**
 * Create a signing identity for registration/login.
 * Returns everything needed for the registration flow.
 */
export async function createSigningIdentity(identityName: string): Promise<{
  signaturePublicKey: Uint8Array
  /** The serialized provider storage — contains the Ed25519 private key. Encrypt with password. */
  privateKeyBundle: Uint8Array
  /** The serialized identity — small blob (name + public key ref). Store alongside the bundle. */
  identityData: Uint8Array
}> {
  const provider = new Provider()
  const identity = new Identity(provider, identityName)

  return {
    signaturePublicKey: new Uint8Array(identity.signature_public_key()),
    privateKeyBundle: new Uint8Array(provider.serialize_storage()),
    identityData: new Uint8Array(identity.serialize())
  }
}

/**
 * Generate a batch of key packages using a previously created signing identity.
 * Each key package gets its own Provider copy (for independent key lifecycle).
 */
export async function createKeyPackageBatch(
  identityData: Uint8Array,
  privateKeyBundle: Uint8Array,
  count: number
): Promise<Array<{ publicData: Uint8Array; privateData: Uint8Array }>> {
  const results: Array<{ publicData: Uint8Array; privateData: Uint8Array }> = []

  for (let i = 0; i < count; i++) {
    // Each key package gets its own Provider (independent lifecycle)
    const provider = new Provider()
    provider.deserialize_storage(privateKeyBundle)
    const identity = Identity.deserialize(provider, identityData)
    const kp = identity.key_package(provider)

    results.push({
      publicData: new Uint8Array(kp.to_bytes()),
      // Save the provider storage which now includes the new key package's keys
      privateData: new Uint8Array(provider.serialize_storage())
    })
  }

  return results
}

/**
 * Encode a KeyPackage to bytes for transmission.
 */
export function encodeKeyPackageBytes(keyPackage: WasmKeyPackage): Uint8Array {
  return keyPackage.to_bytes()
}

/**
 * Decode a KeyPackage from its serialized form.
 */
export function decodeKeyPackageBytes(bytes: Uint8Array): WasmKeyPackage {
  return WasmKeyPackage.from_bytes(bytes)
}

// ============================================================
// Group Creation & Joining
// ============================================================

/**
 * Create a new MLS group. The creator is automatically the first member.
 */
export async function createMLSGroup(
  groupId: string,
  identityName: string
): Promise<GroupState> {
  const provider = new Provider()
  const identity = new Identity(provider, identityName)
  const group = Group.create_new(provider, identity, groupId)

  return makeGroupState(provider, identity, group)
}

/**
 * Process a Welcome message to join an existing MLS group.
 * The privateData must be the serialized Provider storage from the key package
 * that was consumed to generate this Welcome.
 */
export async function processWelcome(
  welcomeBytes: Uint8Array,
  identityName: string,
  privateData?: Uint8Array
): Promise<GroupState> {
  const provider = new Provider()

  // Restore the key package's private keys into the provider.
  // The Welcome is encrypted to a specific key package's HPKE init key,
  // which lives in the provider storage.
  if (privateData) {
    provider.deserialize_storage(privateData)
  }

  // Join the group. The provider must contain the key package's private keys.
  const group = Group.join_from_welcome(provider, welcomeBytes)

  // Now create an Identity for subsequent operations (sending messages).
  // We create a fresh one because join_from_welcome doesn't need it —
  // it only needs the key package keys in the provider.
  // IMPORTANT: create this AFTER joining, so the new signing keypair
  // doesn't interfere with the join process.
  const identity = new Identity(provider, identityName)

  return makeGroupState(provider, identity, group)
}

/**
 * Join a group via External Commit (RFC 9420 §12.4).
 * The new member adds themselves using published GroupInfo.
 * No existing member needs to be online.
 *
 * Returns the new GroupState and the external commit bytes
 * that must be fanned out to existing members.
 */
export async function joinViaExternalCommit(
  groupInfoBytes: Uint8Array,
  ratchetTreeBytes: Uint8Array | null,
  identityName: string
): Promise<{ state: GroupState; commitBytes: Uint8Array }> {
  const provider = new Provider()
  const identity = new Identity(provider, identityName)

  const ratchetTree = ratchetTreeBytes ? RatchetTree.from_bytes(ratchetTreeBytes) : null
  const result = Group.join_from_external_commit(provider, identity, groupInfoBytes, ratchetTree)

  const commitBytes = result.commit_bytes()
  const group = result.take_group()

  return {
    state: makeGroupState(provider, identity, group),
    commitBytes
  }
}

// ============================================================
// Group Operations
// ============================================================

/**
 * Add a member to an existing MLS group.
 * Returns updated state, commit bytes, and welcome for the new member.
 */
export async function addMemberToGroup(
  state: GroupState,
  memberKeyPackageBytes: Uint8Array
): Promise<{
  newState: GroupState
  commitBytes: Uint8Array
  welcomeBytes: Uint8Array | null
}> {
  const keyPackage = WasmKeyPackage.from_bytes(memberKeyPackageBytes)
  const bundle = state._group.add_member(state._provider, state._identity, keyPackage)
  state._group.merge_pending_commit(state._provider)

  return {
    newState: makeGroupState(state._provider, state._identity, state._group),
    commitBytes: new Uint8Array(bundle.commit),
    welcomeBytes: bundle.welcome ? new Uint8Array(bundle.welcome) : null
  }
}

/**
 * Remove a member from an MLS group.
 */
export async function removeMemberFromGroup(
  state: GroupState,
  leafIndex: number
): Promise<{
  newState: GroupState
  commitBytes: Uint8Array
}> {
  const bundle = state._group.remove_member(state._provider, state._identity, leafIndex)
  state._group.merge_pending_commit(state._provider)

  return {
    newState: makeGroupState(state._provider, state._identity, state._group),
    commitBytes: new Uint8Array(bundle.commit)
  }
}

/**
 * Process a commit message (from another member's Add/Remove/Update/External Commit).
 * Updates local state to the new epoch.
 */
export async function processCommitMessage(
  state: GroupState,
  commitBytes: Uint8Array
): Promise<GroupState> {
  const result = state._group.process_message(state._provider, commitBytes)

  if (result.kind !== 'commit' && result.kind !== 'proposal') {
    // Application message received when expecting commit — shouldn't happen
    // but handle gracefully
  }

  return makeGroupState(state._provider, state._identity, state._group)
}

/**
 * Encrypt a plaintext message for the MLS group.
 */
export async function encryptMessage(
  state: GroupState,
  plaintext: string
): Promise<{
  ciphertext: Uint8Array
  epoch: number
  newState: GroupState
}> {
  const plaintextBytes = new TextEncoder().encode(plaintext)
  const ciphertext = state._group.create_message(state._provider, state._identity, plaintextBytes)
  const epoch = Number(state._group.epoch())

  return {
    ciphertext: new Uint8Array(ciphertext),
    epoch,
    newState: makeGroupState(state._provider, state._identity, state._group)
  }
}

/**
 * Decrypt a ciphertext message from the MLS group.
 */
export async function decryptMessage(
  state: GroupState,
  ciphertext: Uint8Array
): Promise<{
  plaintext: string
  newState: GroupState
} | null> {
  try {
    const result = state._group.process_message(state._provider, ciphertext)

    if (result.kind === 'application' && result.message) {
      return {
        plaintext: new TextDecoder().decode(result.message),
        newState: makeGroupState(state._provider, state._identity, state._group)
      }
    }

    // Commit or proposal — return new state but no message content
    if (result.kind === 'commit' || result.kind === 'proposal') {
      return { plaintext: '', newState: makeGroupState(state._provider, state._identity, state._group) }
    }

    return null
  } catch {
    // Decryption failed — message from before we joined, or corrupted
    return null
  }
}

// ============================================================
// Group State Queries
// ============================================================

/**
 * Check whether a user ID already exists in the group's ratchet tree.
 */
export function groupHasMember(
  state: GroupState,
  ...identities: Array<string | undefined | null>
): boolean {
  const members = JSON.parse(state._group.member_identities()) as string[]
  const candidates = new Set(
    identities.filter((id): id is string => typeof id === 'string' && id.length > 0)
  )

  return members.some(member => {
    const userId = member.split(MLS_IDENTITY_SEPARATOR)[0]
    return candidates.has(member) || candidates.has(userId)
  })
}

/**
 * Get all member user IDs (without device suffix) in the group.
 */
export function getGroupMemberIdentities(state: GroupState): string[] {
  const members = JSON.parse(state._group.member_identities()) as string[]
  const userIds = new Set<string>()

  for (const member of members) {
    const userId = member.split(MLS_IDENTITY_SEPARATOR)[0]
    userIds.add(userId)
  }

  return [...userIds]
}

/**
 * Get all member leaf identities (with device suffix) in the group.
 */
export function getGroupLeafIdentities(state: GroupState): string[] {
  return JSON.parse(state._group.member_identities()) as string[]
}

/**
 * Find a member's leaf index by identity.
 * Returns null if not found.
 */
export function findMemberLeafIndex(
  state: GroupState,
  ...identities: Array<string | undefined | null>
): number | null {
  const members = JSON.parse(state._group.member_identities()) as string[]
  const candidates = new Set(
    identities.filter((id): id is string => typeof id === 'string' && id.length > 0)
  )

  for (let i = 0; i < members.length; i++) {
    const member = members[i]
    const userId = member.split(MLS_IDENTITY_SEPARATOR)[0]
    if (candidates.has(member) || candidates.has(userId)) {
      return i
    }
  }

  return null
}

/**
 * Find a member's leaf index by exact identity string.
 */
export function findExactMemberLeafIndex(
  state: GroupState,
  identity: string | undefined | null
): number | null {
  if (!identity) return null

  const members = JSON.parse(state._group.member_identities()) as string[]
  const index = members.indexOf(identity)
  return index >= 0 ? index : null
}

// ============================================================
// GroupInfo (for External Commits)
// ============================================================

/**
 * Export GroupInfo for publishing to the server.
 * Should be called after each epoch change.
 */
export function exportGroupInfo(state: GroupState): Uint8Array {
  return state._group.export_group_info(state._provider, state._identity)
}

/**
 * Export the ratchet tree for publishing alongside GroupInfo.
 */
export function exportRatchetTree(state: GroupState): Uint8Array {
  return state._group.export_ratchet_tree().to_bytes()
}

// ============================================================
// Voice Key Derivation
// ============================================================

/**
 * Derive a 128-bit voice encryption key from the MLS group's exporter secret.
 */
export async function deriveVoiceKey(state: GroupState): Promise<Uint8Array> {
  return state._group.export_secret(state._provider, 'voice-e2ee', new Uint8Array(0), 16)
}

// ============================================================
// Serialization (Persistence)
// ============================================================

/**
 * Serialize MLS group state for local storage.
 * Stores the Provider's full storage (all keys + group state) and Identity info.
 */
export function serializeGroupState(state: GroupState): Uint8Array {
  const providerData = state._provider.serialize_storage()
  const identityData = state._identity.serialize()
  const groupId = state._group.group_id()
  const groupIdBytes = new TextEncoder().encode(groupId)

  // Format: groupIdLen(u32-be) groupId identityLen(u32-be) identityData providerData
  const buf = new Uint8Array(4 + groupIdBytes.length + 4 + identityData.length + providerData.length)
  const view = new DataView(buf.buffer)
  let offset = 0

  view.setUint32(offset, groupIdBytes.length)
  offset += 4
  buf.set(groupIdBytes, offset)
  offset += groupIdBytes.length

  view.setUint32(offset, identityData.length)
  offset += 4
  buf.set(identityData, offset)
  offset += identityData.length

  buf.set(providerData, offset)

  return buf
}

/**
 * Deserialize MLS group state from local storage.
 */
export function deserializeGroupState(bytes: Uint8Array): GroupState {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0

  const groupIdLen = view.getUint32(offset)
  offset += 4
  const groupId = new TextDecoder().decode(bytes.slice(offset, offset + groupIdLen))
  offset += groupIdLen

  const identityLen = view.getUint32(offset)
  offset += 4
  const identityData = bytes.slice(offset, offset + identityLen)
  offset += identityLen

  const providerData = bytes.slice(offset)

  // Restore provider, identity, and group
  const provider = new Provider()
  provider.deserialize_storage(providerData)
  const identity = Identity.deserialize(provider, identityData)
  const group = Group.load(provider, groupId)

  return makeGroupState(provider, identity, group)
}

// ============================================================
// Internal Helpers
// ============================================================

function makeGroupState(provider: Provider, identity: Identity, group: Group): GroupState {
  return {
    _provider: provider,
    _identity: identity,
    _group: group,
    groupContext: {
      get epoch() {
        return group.epoch()
      }
    }
  }
}

/**
 * Build an identity data blob from a name and public key.
 * This matches the format produced by Identity.serialize() in the WASM bindings.
 * Used to reconstruct identity data from persisted storage without having the
 * original Identity object.
 */
export function buildIdentityData(identityName: string, signaturePublicKey: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(identityName)
  const buf = new Uint8Array(4 + nameBytes.length + 4 + signaturePublicKey.length)
  const view = new DataView(buf.buffer)

  let offset = 0
  view.setUint32(offset, nameBytes.length)
  offset += 4
  buf.set(nameBytes, offset)
  offset += nameBytes.length
  view.setUint32(offset, signaturePublicKey.length)
  offset += 4
  buf.set(signaturePublicKey, offset)

  return buf
}
