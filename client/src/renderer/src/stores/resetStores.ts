/**
 * Centralized store reset for logout.
 *
 * Clears all Zustand stores, in-memory caches, and module-level timers
 * so that a second user logging into the same browser tab cannot see
 * the previous user's decrypted messages or cryptographic state.
 *
 * Fixes: https://github.com/vesper-chat/vesper/issues/21
 */
import { useMessageStore, clearExpiryTimers } from './messageStore'
import { useServerStore } from './serverStore'
import { useDmStore } from './dmStore'
import { useUnreadStore } from './unreadStore'
import { usePresenceStore, cleanupPresenceTimers } from './presenceStore'
import { useVoiceStore } from './voiceStore'
import { useSyncStore } from './syncStore'
import { useAttachmentTransferStore } from './attachmentTransferStore'
import { clearDecryptionCache } from '@vesper/sdk/crypto'
import { getRendererStorageRuntime } from '../sdk/client'
import { clearAttachmentObjectUrlCache } from '../utils/attachmentObjectUrlCache'
import { clearEncryptedAttachmentStaging } from '../utils/attachmentEncryptionStaging'
import { abortActiveAttachmentTransfers } from '../utils/attachmentTransfer'

/**
 * Reset all application state to initial values.
 * Called during logout, before clearing auth tokens.
 */
export async function resetAllStores(): Promise<void> {
  // Disconnect voice if active
  const voice = useVoiceStore.getState()
  if (voice.state !== 'idle') {
    voice.disconnect()
  }

  // Leave presence channels and clear timers
  usePresenceStore.getState().leaveAllServerPresence()
  cleanupPresenceTimers()

  // Clear message expiry timers
  clearExpiryTimers()

  // Clear decrypted message and attachment bytes before another account can use
  // this renderer process.
  abortActiveAttachmentTransfers()
  clearDecryptionCache()
  clearAttachmentObjectUrlCache()
  await window.attachmentMedia?.clear()
  await clearEncryptedAttachmentStaging()

  // Reset the IndexedDB adapter singleton so the next login
  // opens a user-scoped database
  getRendererStorageRuntime().reset()

  // Reset all Zustand stores to initial state
  useMessageStore.setState({
    messagesByChannel: {},
    loadingByScope: {},
    loadedByScope: {},
    activeScopeId: null,
    recentScopeIds: [],
    scopeLifecycleById: {},
    typingUsers: {},
    hasMore: {},
    hasNewer: {},
    replyingTo: null,
    editingMessage: null,
    encryptionError: null,
    activeThreadParentId: null,
    activeThreadParent: null,
    threadRepliesByParent: {},
    threadLoading: false,
    threadError: null,
    pendingJumpTarget: null,
    focusedMessageId: null,
    pinnedByChannel: {}
  })

  useServerStore.setState({
    servers: [],
    activeServerId: null,
    activeChannelId: null,
    members: []
  })

  useDmStore.setState({
    conversations: [],
    selectedConversationId: null,
    hasMoreConversations: false,
    loadingMoreConversations: false
  })

  useUnreadStore.setState({
    channelUnreads: {},
    dmUnreads: {}
  })

  useSyncStore.getState().resetToken()
  useAttachmentTransferStore.getState().reset()

  usePresenceStore.setState({
    statuses: {},
    myStatus: 'online',
    connected: false
  })

  useVoiceStore.setState({
    state: 'idle',
    roomId: null,
    roomType: null,
    participants: [],
    muted: false,
    deafened: false,
    incomingCall: null,
    trackMap: {}
    // Preserve device preferences — they're not user-specific
  })
}
