import { create } from 'zustand'
import type { ClientState } from 'ts-mls'
import { getLocalDeviceIdentity } from '../auth/deviceIdentity'
import {
  buildClientCredentialIdentity,
  initCipherSuite,
  createMLSGroup,
  addMemberToGroup,
  removeMemberFromGroup,
  processWelcome,
  processCommitMessage,
  encryptMessage,
  decryptMessage,
  serializeGroupState,
  deserializeGroupState,
  createKeyPackageBatch,
  encodeKeyPackageBytes,
  decodeKeyPackageBytes,
  deriveVoiceKey,
  groupHasMember,
  getGroupLeafIdentities,
  getGroupMemberIdentities,
  findMemberLeafIndex
} from '../crypto/mls'
import {
  saveGroupState,
  loadGroupState,
  deleteGroupState,
  loadKeyPackages,
  consumeKeyPackage
} from '../crypto/storage'
import { deserializePrivatePackage } from '../crypto/keySerialization'
import { fetchKeyPackage, fetchPendingWelcomes, ackPendingWelcome } from '../api/crypto'
import { base64ToUint8, uint8ToBase64 } from '../api/crypto'
import { useAuthStore } from './authStore'
import { withGroupLock } from '../crypto/groupLock'
import { cacheSentMessage } from '../crypto/decryptionCache'

function isAlreadyMemberValidationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /already in the group/i.test(error.message)
  )
}

async function loadOrderedWelcomeKeyPackages(
  keyPackageRef?: string | null
): Promise<
  Array<{
    id: number
    publicData: Uint8Array
    privateData: Uint8Array
  }>
> {
  const localPackages = await loadKeyPackages()
  if (
    typeof keyPackageRef !== 'string' ||
    keyPackageRef.length === 0 ||
    localPackages.length === 0
  ) {
    return localPackages
  }

  const matchingPackages = localPackages.filter(
    (pkg) => uint8ToBase64(new Uint8Array(pkg.publicData)) === keyPackageRef
  )
  if (matchingPackages.length > 0) {
    return [
      ...matchingPackages,
      ...localPackages.filter(
        (pkg) => uint8ToBase64(new Uint8Array(pkg.publicData)) !== keyPackageRef
      )
    ]
  }

  // Replenishment saves local packages asynchronously relative to the UI. If a
  // Welcome arrives while a new device is still finishing setup, retry once so
  // we can pick up the matching private package as soon as it lands locally.
  await new Promise((resolve) => setTimeout(resolve, 150))

  const retriedPackages = await loadKeyPackages()
  return [
    ...retriedPackages.filter(
      (pkg) => uint8ToBase64(new Uint8Array(pkg.publicData)) === keyPackageRef
    ),
    ...retriedPackages.filter(
      (pkg) => uint8ToBase64(new Uint8Array(pkg.publicData)) !== keyPackageRef
    )
  ]
}

export interface JoinRequestResult {
  commitBytes: string
  welcomeBytes: string | null
  keyPackageRef: string | null
}

export interface ResyncRequestResult extends JoinRequestResult {
  removeCommitBytes: string | null
}

interface CryptoState {
  /** In-memory MLS group states keyed by channel ID */
  groupStates: Record<string, ClientState>
  /** Whether we're currently setting up a group */
  groupSetupInProgress: Record<string, boolean>
  /** Commits received before local state is ready */
  pendingCommits: Record<string, string[]>

  /** Ensure this user is a member of the MLS group for a channel */
  ensureGroupMembership: (channelId: string) => Promise<void>
  /** Create a new MLS group for a channel (first user) */
  createGroup: (channelId: string) => Promise<void>
  /** Handle a join request from another user */
  handleJoinRequest: (
    channelId: string,
    userId: string,
    username?: string,
    deviceId?: string
  ) => Promise<JoinRequestResult | null>
  /** Remove and re-add a member to repair their local MLS state */
  handleResyncRequest: (
    channelId: string,
    userId: string,
    username?: string,
    deviceId?: string
  ) => Promise<ResyncRequestResult | null>
  /** Process a Welcome message to join an existing group */
  handleWelcome: (
    channelId: string,
    welcomeData: string,
    keyPackageRef?: string | null
  ) => Promise<boolean>
  /** Process a Commit message to update group state */
  handleCommit: (channelId: string, commitData: string) => Promise<void>
  /** Encrypt a plaintext message for a channel */
  encryptForChannel: (channelId: string, plaintext: string) => Promise<{
    ciphertext: string
    epoch: number
  } | null>
  /** Decrypt a ciphertext message from a channel */
  decryptForChannel: (channelId: string, ciphertext: string) => Promise<string | null>
  /** Check if a channel has an active MLS group */
  hasGroup: (channelId: string) => boolean
  /** Count current MLS members for a channel */
  getMemberCount: (channelId: string) => number
  /** Clear local group state and trigger rejoin */
  resetGroup: (channelId: string) => Promise<void>
  /** Derive a 128-bit voice encryption key from the MLS group's epoch secret */
  getVoiceKey: (channelId: string) => Promise<Uint8Array | null>
}

export const useCryptoStore = create<CryptoState>((set, get) => ({
  groupStates: {},
  groupSetupInProgress: {},
  pendingCommits: {},

  ensureGroupMembership: async (channelId) => {
    if (!useAuthStore.getState().canUseE2EE) {
      return
    }

    // Already have state in memory
    if (get().groupStates[channelId]) {
      const pending = get().pendingCommits[channelId] ?? []
      if (pending.length > 0) {
        set((s) => ({
          pendingCommits: {
            ...s.pendingCommits,
            [channelId]: []
          }
        }))
        for (const commitData of pending) {
          await get().handleCommit(channelId, commitData)
        }
      }
      return
    }

    // Check local DB for persisted state
    const persisted = await loadGroupState(channelId)
    if (persisted) {
      try {
        const state = deserializeGroupState(new Uint8Array(persisted.state))
        set((s) => ({
          groupStates: { ...s.groupStates, [channelId]: state }
        }))
        const pending = get().pendingCommits[channelId] ?? []
        if (pending.length > 0) {
          set((s) => ({
            pendingCommits: {
              ...s.pendingCommits,
              [channelId]: []
            }
          }))
          for (const commitData of pending) {
            await get().handleCommit(channelId, commitData)
          }
        }
        return
      } catch {
        // Corrupted state — delete and re-request join
        await deleteGroupState(channelId)
      }
    }

    // Check for pending welcomes (offline delivery)
    const welcomes = await fetchPendingWelcomes(channelId)
    for (const welcome of welcomes) {
      if (get().groupStates[channelId]) {
        await ackPendingWelcome(welcome.id).catch(() => {})
        return
      }

      const processed = await get().handleWelcome(
        channelId,
        uint8ToBase64(welcome.welcome_data),
        welcome.key_package_ref
      )
      if (processed || get().groupStates[channelId]) {
        await ackPendingWelcome(welcome.id)
        return
      }
    }

    // No group exists or we're not in it — will be handled by mls_request_join
    // The messageStore triggers this after channel join
  },

  createGroup: async (channelId) => {
    if (!useAuthStore.getState().canUseE2EE) return
    if (get().groupStates[channelId] || get().groupSetupInProgress[channelId]) return

    await withGroupLock(channelId, async () => {
      // Re-check after acquiring lock
      if (get().groupStates[channelId]) return

      set((s) => ({
        groupSetupInProgress: { ...s.groupSetupInProgress, [channelId]: true }
      }))

      try {
        await initCipherSuite()
        const user = useAuthStore.getState().user
        if (!user) return

        // Get a local key package to use as the creator
        const localPackages = await loadKeyPackages()
        let publicPackage, privatePackage

        if (localPackages.length === 0) {
          // Generate one on the fly
          const pairs = await createKeyPackageBatch(
            buildClientCredentialIdentity(user.id, getLocalDeviceIdentity().id),
            1
          )
          publicPackage = pairs[0].publicPackage
          privatePackage = pairs[0].privatePackage
        } else {
          // Use first available local key package
          const pkg = localPackages[0]
          await consumeKeyPackage(pkg.id)

          publicPackage = decodeKeyPackageBytes(new Uint8Array(pkg.publicData))
          privatePackage = deserializePrivatePackage(new Uint8Array(pkg.privateData))
        }

        const state = await createMLSGroup(channelId, publicPackage, privatePackage)
        const serialized = serializeGroupState(state)
        await saveGroupState(channelId, serialized, Number(state.groupContext.epoch))

        set((s) => ({
          groupStates: { ...s.groupStates, [channelId]: state }
        }))

        // Replenish key packages after consuming one for group creation
        useAuthStore.getState().replenishKeyPackages().catch(() => {})
      } catch (e) {
        console.error('Failed to create MLS group:', e)
      } finally {
        set((s) => ({
          groupSetupInProgress: { ...s.groupSetupInProgress, [channelId]: false }
        }))
      }
    })
  },

  handleJoinRequest: async (channelId, userId, username, deviceId) => {
    if (!useAuthStore.getState().canUseE2EE) return null
    if (!get().groupStates[channelId]) return // We're not the group owner / don't have state

    return withGroupLock(channelId, async () => {
      const state = get().groupStates[channelId]
      if (!state) return // Re-check after acquiring lock

      try {
        await initCipherSuite()
        const localUser = useAuthStore.getState().user
        const memberIdentities = getGroupMemberIdentities(state)
        const memberLeafIdentities = getGroupLeafIdentities(state)
        const isSameUser = localUser ? userId === localUser.id : false

        if (
          !localUser ||
          !memberIdentities.some(
            (identity) => identity === localUser.id || identity === localUser.username
          ) ||
          (!isSameUser &&
            memberIdentities[0] !== localUser.id &&
            memberIdentities[0] !== localUser.username)
        ) {
          return null
        }

        // Skip duplicate member check for same-user different-device joins.
        // Multi-device: the same user joins from a new device with a different
        // key package. Both devices coexist as separate leaves in the MLS tree.
        if (!isSameUser && groupHasMember(state, userId, username)) {
          console.warn(`Skipping MLS join request for existing member ${userId} in ${channelId}`)
          return null
        }

        // Fetch the requesting user's key package from the directory
        const keyPackageBytes = await fetchKeyPackage(userId, deviceId)
        if (!keyPackageBytes) {
          console.warn(`No key package available for user ${userId}`)
          return null
        }

        const memberKeyPackage = decodeKeyPackageBytes(keyPackageBytes)
        const requestedCredential = memberKeyPackage.leafNode.credential
        const requestedIdentity =
          requestedCredential.credentialType === 'basic'
            ? new TextDecoder().decode(requestedCredential.identity)
            : null

        if (requestedIdentity && memberLeafIdentities.includes(requestedIdentity)) {
          return null
        }

        if (
          !isSameUser &&
          requestedIdentity &&
          groupHasMember(state, requestedIdentity, userId, username)
        ) {
          console.warn(
            `Skipping MLS join request for existing member ${requestedIdentity} in ${channelId}`
          )
          return null
        }

        const result = await addMemberToGroup(state, memberKeyPackage)

        // Update local state
        const serialized = serializeGroupState(result.newState)
        await saveGroupState(channelId, serialized, Number(result.newState.groupContext.epoch))

        set((s) => ({
          groupStates: { ...s.groupStates, [channelId]: result.newState }
        }))

        // Return commit and welcome bytes for the caller to broadcast
        // This is called from messageStore which handles the channel push
        return {
          commitBytes: uint8ToBase64(result.commitBytes),
          welcomeBytes: result.welcomeBytes ? uint8ToBase64(result.welcomeBytes) : null,
          keyPackageRef: uint8ToBase64(keyPackageBytes)
        }
      } catch (e) {
        if (isAlreadyMemberValidationError(e)) {
          return null
        }
        console.error('Failed to handle join request:', e)
        return null
      }
    })
  },

  handleResyncRequest: async (channelId, userId, username, deviceId) => {
    if (!useAuthStore.getState().canUseE2EE) return
    if (!get().groupStates[channelId]) return

    return withGroupLock(channelId, async () => {
      const state = get().groupStates[channelId]
      if (!state) return

      try {
        await initCipherSuite()
        const localUser = useAuthStore.getState().user
        const memberIdentities = getGroupMemberIdentities(state)
        const isSameUser = localUser ? userId === localUser.id : false

        if (
          !localUser ||
          !memberIdentities.some(
            (identity) => identity === localUser.id || identity === localUser.username
          ) ||
          (!isSameUser &&
            memberIdentities[0] !== localUser.id &&
            memberIdentities[0] !== localUser.username)
        ) {
          return null
        }

        const keyPackageBytes = await fetchKeyPackage(userId, deviceId)
        if (!keyPackageBytes) {
          console.warn(`No key package available for user ${userId}`)
          return null
        }

        const memberKeyPackage = decodeKeyPackageBytes(keyPackageBytes)
        const requestedCredential = memberKeyPackage.leafNode.credential
        const requestedIdentity =
          requestedCredential.credentialType === 'basic'
            ? new TextDecoder().decode(requestedCredential.identity)
            : null

        let workingState = state
        let removeCommitBytes: string | null = null

        const existingLeafIndex =
          requestedIdentity && groupHasMember(workingState, requestedIdentity)
            ? findMemberLeafIndex(workingState, requestedIdentity)
            : isSameUser
              ? null
              : findMemberLeafIndex(workingState, userId, username, requestedIdentity)

        if (existingLeafIndex !== null) {
          const removed = await removeMemberFromGroup(workingState, existingLeafIndex)
          workingState = removed.newState
          removeCommitBytes = uint8ToBase64(removed.commitBytes)
        }

        if (requestedIdentity && groupHasMember(workingState, requestedIdentity)) {
          return null
        }

        const added = await addMemberToGroup(workingState, memberKeyPackage)
        const serialized = serializeGroupState(added.newState)
        await saveGroupState(channelId, serialized, Number(added.newState.groupContext.epoch))

        set((s) => ({
          groupStates: { ...s.groupStates, [channelId]: added.newState }
        }))

        return {
          removeCommitBytes,
          commitBytes: uint8ToBase64(added.commitBytes),
          welcomeBytes: added.welcomeBytes ? uint8ToBase64(added.welcomeBytes) : null,
          keyPackageRef: uint8ToBase64(keyPackageBytes)
        }
      } catch (e) {
        console.error('Failed to handle resync request:', e)
        return null
      }
    })
  },

  handleWelcome: async (channelId, welcomeData, keyPackageRef) => {
    if (!useAuthStore.getState().canUseE2EE) {
      return false
    }

    return withGroupLock(channelId, async () => {
      try {
        await initCipherSuite()
        const welcomeBytes = base64ToUint8(welcomeData)

        const orderedPackages = await loadOrderedWelcomeKeyPackages(keyPackageRef)

        if (orderedPackages.length === 0) {
          console.warn(`No local key packages available to process Welcome for ${channelId}`)
          return false
        }

        for (const pkg of orderedPackages) {
          try {
            const publicPackageBytes = new Uint8Array(pkg.publicData)
            const publicPackage = decodeKeyPackageBytes(publicPackageBytes)
            const privatePackage = deserializePrivatePackage(new Uint8Array(pkg.privateData))
            const state = await processWelcome(welcomeBytes, publicPackage, privatePackage)
            const newEpoch = Number(state.groupContext.epoch)

            // Guard: never regress to a lower epoch if we already have state
            const existing = get().groupStates[channelId]
            if (existing) {
              const existingEpoch = Number(existing.groupContext.epoch)
              if (newEpoch <= existingEpoch) {
                await consumeKeyPackage(pkg.id)
                return false
              }
            }

            const serialized = serializeGroupState(state)
            await saveGroupState(channelId, serialized, newEpoch)
            await consumeKeyPackage(pkg.id)

            set((s) => ({
              groupStates: { ...s.groupStates, [channelId]: state }
            }))

            // Process any pending commits that arrived before the welcome.
            // We process them inline (without handleCommit) because we're
            // already inside withGroupLock and re-acquiring it would deadlock.
            const pending = get().pendingCommits[channelId] ?? []
            if (pending.length > 0) {
              set((s) => ({
                pendingCommits: {
                  ...s.pendingCommits,
                  [channelId]: []
                }
              }))
              for (const pendingCommitData of pending) {
                try {
                  const currentState = get().groupStates[channelId]
                  if (!currentState) break
                  const commitBytes = base64ToUint8(pendingCommitData)
                  const newState = await processCommitMessage(currentState, commitBytes)
                  const ser = serializeGroupState(newState)
                  await saveGroupState(channelId, ser, Number(newState.groupContext.epoch))
                  set((s) => ({
                    groupStates: { ...s.groupStates, [channelId]: newState }
                  }))
                } catch {
                  // Expected: commits for earlier epochs fail harmlessly
                }
              }
            }

            // Replenish key packages after consuming the matched local package.
            useAuthStore.getState().replenishKeyPackages().catch(() => {})
            return true
          } catch {
            continue
          }
        }

        console.warn(`Failed to match Welcome to any local key package for ${channelId}`)
        return false
      } catch (e) {
        console.error('Failed to process Welcome:', e)
        return false
      }
    })
  },

  handleCommit: async (channelId, commitData) => {
    if (!useAuthStore.getState().canUseE2EE) {
      return
    }

    if (!get().groupStates[channelId]) {
      const existing = get().pendingCommits[channelId] ?? []
      if (!existing.includes(commitData)) {
        set((s) => ({
          pendingCommits: {
            ...s.pendingCommits,
            [channelId]: [...existing, commitData]
          }
        }))
      }
      await get().ensureGroupMembership(channelId)
      return
    }

    await withGroupLock(channelId, async () => {
      const RETRY_DELAYS = [100, 500, 2000]
      let lastError: unknown

      for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
        const state = get().groupStates[channelId]
        if (!state) return

        try {
          await initCipherSuite()
          const commitBytes = base64ToUint8(commitData)
          const newState = await processCommitMessage(state, commitBytes)

          const serialized = serializeGroupState(newState)
          await saveGroupState(channelId, serialized, Number(newState.groupContext.epoch))

          set((s) => ({
            groupStates: { ...s.groupStates, [channelId]: newState }
          }))
          return // Success
        } catch (e) {
          lastError = e
          if (attempt < RETRY_DELAYS.length - 1) {
            console.warn(
              `Commit processing failed for ${channelId} (attempt ${attempt + 1}/${RETRY_DELAYS.length}), retrying in ${RETRY_DELAYS[attempt]}ms:`,
              e
            )
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt]))
          }
        }
      }

      // All retries exhausted. Only reset if the state is genuinely stale
      // (epoch 0 with no real progress). If we have a valid group at a higher
      // epoch, the commit was likely for an older epoch (e.g., already applied
      // via Welcome) — just ignore it to avoid destroying good state.
      const currentState = get().groupStates[channelId]
      const currentEpoch = currentState ? Number(currentState.groupContext.epoch) : 0
      if (currentEpoch > 0) {
        console.warn(
          `Commit processing failed for ${channelId} after ${RETRY_DELAYS.length} attempts at epoch ${currentEpoch}, ignoring stale commit:`,
          lastError
        )
        return
      }

      console.error(
        `Commit processing failed for ${channelId} after ${RETRY_DELAYS.length} attempts, resetting group state:`,
        lastError
      )
      set((s) => {
        const { [channelId]: _groupState, ...remainingGroups } = s.groupStates
        return {
          groupStates: remainingGroups,
          pendingCommits: {
            ...s.pendingCommits,
            [channelId]: []
          }
        }
      })
      deleteGroupState(channelId).catch(() => {})
    })
  },

  encryptForChannel: async (channelId, plaintext) => {
    if (!useAuthStore.getState().canUseE2EE) return null
    if (!get().groupStates[channelId]) return null

    return withGroupLock(channelId, async () => {
      const state = get().groupStates[channelId]
      if (!state) return null

      try {
        await initCipherSuite()
        const result = await encryptMessage(state, plaintext)

        // Update state (key ratcheting)
        const serialized = serializeGroupState(result.newState)
        await saveGroupState(channelId, serialized, Number(result.newState.groupContext.epoch))

        set((s) => ({
          groupStates: { ...s.groupStates, [channelId]: result.newState }
        }))

        const ciphertextB64 = uint8ToBase64(result.ciphertext)

        // Cache plaintext so we can display our own message when the server
        // echoes it back. MLS senders can't decrypt their own messages because
        // the ratchet key is consumed during encryption.
        await cacheSentMessage(ciphertextB64, plaintext)

        return {
          ciphertext: ciphertextB64,
          epoch: result.epoch
        }
      } catch (e) {
        console.error('Failed to encrypt message:', e)
        return null
      }
    })
  },

  decryptForChannel: async (channelId, ciphertext) => {
    if (!useAuthStore.getState().canUseE2EE) return null
    if (!get().groupStates[channelId]) return null

    return withGroupLock(channelId, async () => {
      const state = get().groupStates[channelId]
      if (!state) return null

      try {
        await initCipherSuite()
        const ciphertextBytes = base64ToUint8(ciphertext)
        const result = await decryptMessage(state, ciphertextBytes)

        if (!result) return null

        // Update state
        const serialized = serializeGroupState(result.newState)
        await saveGroupState(channelId, serialized, Number(result.newState.groupContext.epoch))

        set((s) => ({
          groupStates: { ...s.groupStates, [channelId]: result.newState }
        }))

        return result.plaintext
      } catch {
        return null
      }
    })
  },

  hasGroup: (channelId) => {
    return !!get().groupStates[channelId]
  },

  getMemberCount: (channelId) => {
    const state = get().groupStates[channelId]
    if (!state) {
      return 0
    }

    return state.ratchetTree.reduce((count, node) => {
      return node && node.nodeType === 'leaf' ? count + 1 : count
    }, 0)
  },

  resetGroup: async (channelId) => {
    await withGroupLock(channelId, async () => {
      set((s) => {
        const { [channelId]: _groupState, ...remainingGroups } = s.groupStates
        return {
          groupStates: remainingGroups,
          pendingCommits: {
            ...s.pendingCommits,
            [channelId]: []
          }
        }
      })
      await deleteGroupState(channelId).catch(() => {})
    })
  },

  getVoiceKey: async (channelId) => {
    if (!useAuthStore.getState().canUseE2EE) return null
    const state = get().groupStates[channelId]
    if (!state) return null

    try {
      await initCipherSuite()
      return deriveVoiceKey(state)
    } catch (e) {
      console.error('Failed to derive voice key:', e)
      return null
    }
  }
}))
