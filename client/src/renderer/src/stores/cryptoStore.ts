import { create } from 'zustand'
import type { ClientState } from 'ts-mls'
import { getLocalDeviceIdentity } from '@vesper/sdk/auth'
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
} from '@vesper/sdk/crypto'
import {
  saveGroupState,
  loadGroupState,
  loadGroupSyncCursor,
  deleteGroupState,
  saveGroupSyncCursor,
  loadKeyPackages,
  consumeKeyPackage
} from '@vesper/sdk/crypto'
import { deserializePrivatePackage } from '@vesper/sdk/crypto'
import {
  fetchKeyPackage,
  fetchMlsEvents,
  fetchPendingWelcomes,
  ackPendingWelcome
} from '@vesper/sdk/api'
import { base64ToUint8, uint8ToBase64 } from '@vesper/sdk/api'
import { useAuthStore } from './authStore'
import { cacheSentMessage, type GroupLockPriority, withGroupLock } from '@vesper/sdk/crypto'

const BACKGROUND_DECRYPT_CHUNK_SIZE = 8
const inFlightMlsEventReplays = new Map<string, Promise<void>>()
const inFlightPendingWelcomeChecks = new Map<string, Promise<boolean>>()
const lastPendingWelcomeCheckAt = new Map<string, number>()
const PENDING_WELCOME_CHECK_COOLDOWN_MS = 1500

interface PendingCommit {
  commitData: string
  eventSeq: number | null
}

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

export type EvictionRequestResult =
  | {
      action: 'remove'
      commitBytes: string
    }
  | {
      action: 'skip'
      reason: string
    }

interface CryptoState {
  /** In-memory MLS group states keyed by channel ID */
  groupStates: Record<string, ClientState>
  /** Whether we're currently setting up a group */
  groupSetupInProgress: Record<string, boolean>
  /** Commits received before local state is ready */
  pendingCommits: Record<string, PendingCommit[]>
  /** Durable MLS event cursor keyed by scope ID */
  groupEventCursors: Record<string, number>
  /** Recently applied Welcome messages awaiting post-join follow-up */
  welcomeAppliedAtByScope: Record<string, number>

  /** Ensure this user is a member of the MLS group for a channel */
  ensureGroupMembership: (channelId: string) => Promise<boolean>
  /** Consume a pending Welcome-applied marker for a scope */
  consumeWelcomeApplied: (channelId: string) => boolean
  /** Persist the highest replayed MLS event sequence for a scope */
  markScopeEventApplied: (channelId: string, eventSeq: number) => Promise<void>
  /** Replay missed durable MLS events for a scope before message hydration */
  replayMissedScopeEvents: (channelId: string) => Promise<void>
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
  /** Handle a cryptographic eviction request from a trusted member */
  handleEvictionRequest: (
    channelId: string,
    userId: string,
    deviceId?: string
  ) => Promise<EvictionRequestResult | null>
  /** Process a Welcome message to join an existing group */
  handleWelcome: (
    channelId: string,
    welcomeData: string,
    keyPackageRef?: string | null
  ) => Promise<boolean>
  /** Process a Commit message to update group state */
  handleCommit: (
    channelId: string,
    commitData: string,
    eventSeq?: number | null
  ) => Promise<boolean>
  /** Encrypt a plaintext message for a channel */
  encryptForChannel: (channelId: string, plaintext: string) => Promise<{
    ciphertext: string
    epoch: number
  } | null>
  /** Decrypt a ciphertext message from a channel */
  decryptForChannel: (
    channelId: string,
    ciphertext: string,
    priority?: GroupLockPriority
  ) => Promise<string | null>
  /** Decrypt a batch of ciphertext messages while holding the room lock once */
  decryptBatchForChannel: (
    channelId: string,
    ciphertexts: string[],
    priority?: GroupLockPriority
  ) => Promise<Array<string | null>>
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
  groupEventCursors: {},
  welcomeAppliedAtByScope: {},

  consumeWelcomeApplied: (channelId) => {
    const appliedAt = get().welcomeAppliedAtByScope[channelId]
    if (appliedAt == null) {
      return false
    }

    set((s) => {
      const { [channelId]: _ignored, ...remaining } = s.welcomeAppliedAtByScope
      return {
        welcomeAppliedAtByScope: remaining
      }
    })

    return true
  },

  markScopeEventApplied: async (channelId, eventSeq) => {
    if (!Number.isFinite(eventSeq) || eventSeq <= 0) {
      return
    }

    const currentCursor =
      get().groupEventCursors[channelId] ?? (await loadGroupSyncCursor(channelId))
    const nextCursor = Math.max(currentCursor, Math.trunc(eventSeq))
    if (nextCursor === currentCursor && get().groupEventCursors[channelId] === nextCursor) {
      return
    }

    await saveGroupSyncCursor(channelId, nextCursor)
    set((s) => ({
      groupEventCursors: {
        ...s.groupEventCursors,
        [channelId]: Math.max(s.groupEventCursors[channelId] ?? 0, nextCursor)
      }
    }))
  },

  replayMissedScopeEvents: async (channelId) => {
    const existingReplay = inFlightMlsEventReplays.get(channelId)
    if (existingReplay) {
      return existingReplay
    }

    const replay = (async () => {
      if (!useAuthStore.getState().canUseE2EE || !get().groupStates[channelId]) {
        return
      }

      const currentUserId = useAuthStore.getState().user?.id ?? null
      const localDeviceId = getLocalDeviceIdentity().id
      const startCursor =
        get().groupEventCursors[channelId] ?? (await loadGroupSyncCursor(channelId))

      if (get().groupEventCursors[channelId] == null) {
        set((s) => ({
          groupEventCursors: {
            ...s.groupEventCursors,
            [channelId]: startCursor
          }
        }))
      }

      let afterSeq = startCursor

      while (true) {
        const events = await fetchMlsEvents(channelId, afterSeq)
        if (events.length === 0) {
          break
        }

        let shouldStopReplay = false

        for (const event of events) {
          const knownCursor = get().groupEventCursors[channelId] ?? startCursor
          if (event.seq <= knownCursor) {
            afterSeq = Math.max(afterSeq, event.seq)
            continue
          }

          const isLocalSender =
            event.sender_id === currentUserId && event.sender_device_id === localDeviceId

          if (event.event_type === 'mls_remove') {
            const payload = event.payload as Record<string, unknown> | undefined
            const removedUserId =
              typeof payload?.removed_user_id === 'string' ? payload.removed_user_id : null
            const removedDeviceId =
              typeof payload?.removed_device_id === 'string'
                ? payload.removed_device_id
                : null
            const commitData =
              typeof payload?.commit_data === 'string' ? payload.commit_data : null

            if (
              removedUserId === currentUserId &&
              (removedDeviceId == null || removedDeviceId === localDeviceId) &&
              !isLocalSender
            ) {
              await get().resetGroup(channelId)
              await get().markScopeEventApplied(channelId, event.seq)
              afterSeq = event.seq
              continue
            }

            if (!commitData) {
              await get().markScopeEventApplied(channelId, event.seq)
              afterSeq = event.seq
              continue
            }

            if (isLocalSender) {
              await get().markScopeEventApplied(channelId, event.seq)
              afterSeq = event.seq
              continue
            }

            const handled = await get().handleCommit(channelId, commitData, event.seq)
            if (!handled) {
              shouldStopReplay = true
              break
            }

            afterSeq = event.seq
            continue
          }

          const commitData =
            typeof event.payload?.commit_data === 'string' ? event.payload.commit_data : null
          if (!commitData) {
            await get().markScopeEventApplied(channelId, event.seq)
            afterSeq = event.seq
            continue
          }

          if (isLocalSender) {
            await get().markScopeEventApplied(channelId, event.seq)
            afterSeq = event.seq
            continue
          }

          const handled = await get().handleCommit(channelId, commitData, event.seq)
          if (!handled) {
            shouldStopReplay = true
            break
          }

          afterSeq = event.seq
        }

        if (shouldStopReplay || events.length < 200) {
          break
        }
      }
    })().finally(() => {
      inFlightMlsEventReplays.delete(channelId)
    })

    inFlightMlsEventReplays.set(channelId, replay)
    return replay
  },

  ensureGroupMembership: async (channelId) => {
    if (!useAuthStore.getState().canUseE2EE) {
      return false
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
        for (const pendingCommit of pending) {
          await get().handleCommit(channelId, pendingCommit.commitData, pendingCommit.eventSeq)
        }
      }

      await get().replayMissedScopeEvents(channelId)
      if (get().groupStates[channelId]) {
        return false
      }
    }

    // Check local DB for persisted state
    const persisted = await loadGroupState(channelId)
    if (persisted) {
      try {
        const state = deserializeGroupState(new Uint8Array(persisted.state))
        set((s) => ({
          groupStates: { ...s.groupStates, [channelId]: state }
        }))
        const persistedCursor = await loadGroupSyncCursor(channelId)
        set((s) => ({
          groupEventCursors: {
            ...s.groupEventCursors,
            [channelId]: persistedCursor
          }
        }))
        const pending = get().pendingCommits[channelId] ?? []
        if (pending.length > 0) {
          set((s) => ({
            pendingCommits: {
              ...s.pendingCommits,
              [channelId]: []
            }
          }))
          for (const pendingCommit of pending) {
            await get().handleCommit(channelId, pendingCommit.commitData, pendingCommit.eventSeq)
          }
        }
        await get().replayMissedScopeEvents(channelId)
        if (get().groupStates[channelId]) {
          return false
        }
      } catch {
        // Corrupted state — delete and re-request join
        await deleteGroupState(channelId)
      }
    }

    const existingPendingWelcomeCheck = inFlightPendingWelcomeChecks.get(channelId)
    if (existingPendingWelcomeCheck) {
      return await existingPendingWelcomeCheck
    }

    const lastWelcomeCheckAt = lastPendingWelcomeCheckAt.get(channelId) ?? 0
    if (Date.now() - lastWelcomeCheckAt < PENDING_WELCOME_CHECK_COOLDOWN_MS) {
      return false
    }

    const pendingWelcomeCheck = (async () => {
      lastPendingWelcomeCheckAt.set(channelId, Date.now())

      // Check for pending welcomes (offline delivery)
      const welcomes = await fetchPendingWelcomes(channelId)
      for (const welcome of welcomes) {
        if (get().groupStates[channelId]) {
          await ackPendingWelcome(welcome.id).catch(() => {})
          return false
        }

        const processed = await get().handleWelcome(
          channelId,
          uint8ToBase64(welcome.welcome_data),
          welcome.key_package_ref
        )
        if (processed || get().groupStates[channelId]) {
          await ackPendingWelcome(welcome.id)
          await get().replayMissedScopeEvents(channelId)
          const { handleWelcomeProcessedForResolvedScope } = await import('./messageStore')
          await handleWelcomeProcessedForResolvedScope(channelId).catch(() => {})
          return true
        }
      }

      return false
    })().finally(() => {
      inFlightPendingWelcomeChecks.delete(channelId)
    })

    inFlightPendingWelcomeChecks.set(channelId, pendingWelcomeCheck)
    return await pendingWelcomeCheck

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

        // Fetch the requesting device's key package first so we can distinguish
        // "same user, new device" from a true duplicate leaf.
        const keyPackageBytes = await fetchKeyPackage(userId, deviceId)
        if (!keyPackageBytes) {
          if (deviceId !== 'legacy') {
            console.warn(`No key package available for user ${userId}`)
          }
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

        // Allow additional devices for an existing member. Only suppress the
        // join if this exact leaf identity is already present.
        if (requestedIdentity && groupHasMember(state, requestedIdentity)) {
          console.warn(
            `Skipping MLS join request for existing leaf ${requestedIdentity} in ${channelId}`
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
          if (deviceId !== 'legacy') {
            console.warn(`No key package available for user ${userId}`)
          }
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
            : null

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

  handleEvictionRequest: async (channelId, userId, deviceId) => {
    if (!useAuthStore.getState().canUseE2EE) return null
    if (!get().groupStates[channelId]) return null

    return withGroupLock(channelId, async () => {
      const state = get().groupStates[channelId]
      if (!state) return null

      try {
        await initCipherSuite()
        const localUser = useAuthStore.getState().user
        const localDeviceId = getLocalDeviceIdentity().id

        if (!localUser || !groupHasMember(state, localUser.id, localUser.username)) {
          return null
        }

        if (
          localUser.id === userId &&
          (deviceId == null || deviceId === localDeviceId)
        ) {
          return null
        }

        const leafIndex =
          deviceId != null
            ? (() => {
                const targetIdentity = buildClientCredentialIdentity(userId, deviceId)
                return getGroupLeafIdentities(state).includes(targetIdentity)
                  ? findMemberLeafIndex(state, targetIdentity)
                  : null
              })()
            : findMemberLeafIndex(state, userId)

        if (leafIndex == null) {
          return {
            action: 'skip',
            reason: 'leaf_missing'
          }
        }

        const removed = await removeMemberFromGroup(state, leafIndex)
        const serialized = serializeGroupState(removed.newState)
        await saveGroupState(channelId, serialized, Number(removed.newState.groupContext.epoch))

        set((s) => ({
          groupStates: { ...s.groupStates, [channelId]: removed.newState }
        }))

        return {
          action: 'remove',
          commitBytes: uint8ToBase64(removed.commitBytes)
        }
      } catch (e) {
        console.error('Failed to handle eviction request:', e)
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
              groupStates: { ...s.groupStates, [channelId]: state },
              welcomeAppliedAtByScope: {
                ...s.welcomeAppliedAtByScope,
                [channelId]: Date.now()
              }
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
              for (const pendingCommit of pending) {
                try {
                  const currentState = get().groupStates[channelId]
                  if (!currentState) break
                  const commitBytes = base64ToUint8(pendingCommit.commitData)
                  const newState = await processCommitMessage(currentState, commitBytes)
                  const ser = serializeGroupState(newState)
                  await saveGroupState(channelId, ser, Number(newState.groupContext.epoch))
                  set((s) => ({
                    groupStates: { ...s.groupStates, [channelId]: newState }
                  }))
                  if (pendingCommit.eventSeq != null) {
                    await get().markScopeEventApplied(channelId, pendingCommit.eventSeq)
                  }
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

  handleCommit: async (channelId, commitData, eventSeq = null) => {
    if (!useAuthStore.getState().canUseE2EE) {
      return false
    }

    if (!get().groupStates[channelId]) {
      const existing = get().pendingCommits[channelId] ?? []
      if (!existing.some((pending) => pending.commitData === commitData)) {
        set((s) => ({
          pendingCommits: {
            ...s.pendingCommits,
            [channelId]: [...existing, { commitData, eventSeq }]
          }
        }))
      }
      await get().ensureGroupMembership(channelId)
      return false
    }

    return withGroupLock(channelId, async () => {
      const RETRY_DELAYS = [100, 500, 2000]
      let lastError: unknown

      for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
        const state = get().groupStates[channelId]
        if (!state) return false

        try {
          await initCipherSuite()
          const commitBytes = base64ToUint8(commitData)
          const newState = await processCommitMessage(state, commitBytes)

          const serialized = serializeGroupState(newState)
          await saveGroupState(channelId, serialized, Number(newState.groupContext.epoch))

          set((s) => ({
            groupStates: { ...s.groupStates, [channelId]: newState }
          }))
          if (eventSeq != null) {
            await get().markScopeEventApplied(channelId, eventSeq)
          }
          return true
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
        if (eventSeq != null) {
          await get().markScopeEventApplied(channelId, eventSeq)
        }
        return true
      }

      console.error(
        `Commit processing failed for ${channelId} after ${RETRY_DELAYS.length} attempts, resetting group state:`,
        lastError
      )
      set((s) => {
        const { [channelId]: _groupState, ...remainingGroups } = s.groupStates
        const { [channelId]: _cursor, ...remainingCursors } = s.groupEventCursors
        return {
          groupStates: remainingGroups,
          groupEventCursors: remainingCursors,
          pendingCommits: {
            ...s.pendingCommits,
            [channelId]: []
          }
        }
      })
      deleteGroupState(channelId).catch(() => {})
      return false
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

  decryptForChannel: async (channelId, ciphertext, priority = 'normal') => {
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
    }, priority)
  },

  decryptBatchForChannel: async (channelId, ciphertexts, priority = 'background') => {
    if (!useAuthStore.getState().canUseE2EE) {
      return ciphertexts.map(() => null)
    }
    if (!get().groupStates[channelId] || ciphertexts.length === 0) {
      return ciphertexts.map(() => null)
    }

    const chunkSize =
      priority === 'background' ? BACKGROUND_DECRYPT_CHUNK_SIZE : ciphertexts.length
    const plaintexts = ciphertexts.map(() => null) as Array<string | null>

    for (let index = 0; index < ciphertexts.length; index += chunkSize) {
      const chunk = ciphertexts.slice(index, index + chunkSize)

      const chunkPlaintexts = await withGroupLock(channelId, async () => {
        const initialState = get().groupStates[channelId]
        if (!initialState) {
          return chunk.map(() => null)
        }

        try {
          await initCipherSuite()

          let workingState = initialState
          let stateChanged = false
          const currentPlaintexts: Array<string | null> = []

          for (const ciphertext of chunk) {
            try {
              const result = await decryptMessage(workingState, base64ToUint8(ciphertext))
              if (!result) {
                currentPlaintexts.push(null)
                continue
              }

              workingState = result.newState
              stateChanged = true
              currentPlaintexts.push(result.plaintext)
            } catch {
              currentPlaintexts.push(null)
            }
          }

          if (stateChanged) {
            const serialized = serializeGroupState(workingState)
            await saveGroupState(channelId, serialized, Number(workingState.groupContext.epoch))
            set((s) => ({
              groupStates: { ...s.groupStates, [channelId]: workingState }
            }))
          }

          return currentPlaintexts
        } catch {
          return chunk.map(() => null)
        }
      }, priority)

      chunkPlaintexts.forEach((plaintext, chunkIndex) => {
        plaintexts[index + chunkIndex] = plaintext
      })

      if (priority === 'background' && index + chunkSize < ciphertexts.length) {
        await new Promise((resolve) => window.setTimeout(resolve, 0))
      }
    }

    return plaintexts
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
        const { [channelId]: _cursor, ...remainingCursors } = s.groupEventCursors
        return {
          groupStates: remainingGroups,
          groupEventCursors: remainingCursors,
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
