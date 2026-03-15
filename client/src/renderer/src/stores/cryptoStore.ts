import { create } from 'zustand'
import type { ClientState } from 'ts-mls'
import {
  initCipherSuite,
  createMLSGroup,
  addMemberToGroup,
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
  groupHasMember
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

export interface JoinRequestResult {
  commitBytes: string
  welcomeBytes: string | null
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
  handleJoinRequest: (channelId: string, userId: string) => Promise<JoinRequestResult | null>
  /** Process a Welcome message to join an existing group */
  handleWelcome: (channelId: string, welcomeData: string) => Promise<boolean>
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
      const processed = await get().handleWelcome(channelId, uint8ToBase64(welcome.welcome_data))
      if (processed) {
        await ackPendingWelcome(welcome.id)
        return
      }
    }

    // No group exists or we're not in it — will be handled by mls_request_join
    // The messageStore triggers this after channel join
  },

  createGroup: async (channelId) => {
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
          const pairs = await createKeyPackageBatch(user.username, 1)
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

  handleJoinRequest: async (channelId, userId) => {
    if (!get().groupStates[channelId]) return // We're not the group owner / don't have state

    return withGroupLock(channelId, async () => {
      const state = get().groupStates[channelId]
      if (!state) return // Re-check after acquiring lock

      try {
        await initCipherSuite()

        if (groupHasMember(state, userId)) {
          console.warn(`Skipping MLS join request for existing member ${userId} in ${channelId}`)
          return null
        }

        // Fetch the requesting user's key package from the directory
        const keyPackageBytes = await fetchKeyPackage(userId)
        if (!keyPackageBytes) {
          console.warn(`No key package available for user ${userId}`)
          return
        }

        const memberKeyPackage = decodeKeyPackageBytes(keyPackageBytes)
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
          welcomeBytes: result.welcomeBytes ? uint8ToBase64(result.welcomeBytes) : null
        }
      } catch (e) {
        console.error('Failed to handle join request:', e)
        return null
      }
    })
  },

  handleWelcome: async (channelId, welcomeData) => {
    return withGroupLock(channelId, async () => {
      try {
        await initCipherSuite()
        const welcomeBytes = base64ToUint8(welcomeData)

        // Get a local key package
        const localPackages = await loadKeyPackages()

        if (localPackages.length === 0) {
          console.warn(`No local key packages available to process Welcome for ${channelId}`)
          return false
        }

        for (const pkg of localPackages) {
          try {
            const publicPackageBytes = new Uint8Array(pkg.publicData)
            const publicPackage = decodeKeyPackageBytes(publicPackageBytes)
            const privatePackage = deserializePrivatePackage(new Uint8Array(pkg.privateData))
            const state = await processWelcome(welcomeBytes, publicPackage, privatePackage)
            const serialized = serializeGroupState(state)
            await saveGroupState(channelId, serialized, Number(state.groupContext.epoch))
            await consumeKeyPackage(pkg.id)

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

      // All retries exhausted — reset group state so the next operation triggers a rejoin
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
        cacheSentMessage(ciphertextB64, plaintext)

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
