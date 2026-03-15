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
import { useCryptoStore } from './cryptoStore'
import { useServerStore } from './serverStore'
import { useDmStore } from './dmStore'
import { useUnreadStore } from './unreadStore'
import { usePresenceStore, cleanupPresenceTimers } from './presenceStore'
import { useVoiceStore } from './voiceStore'
import { clearDecryptionCache } from '../crypto/decryptionCache'
import { resetStorage } from '../crypto/storage'

/**
 * Reset all application state to initial values.
 * Called during logout, before clearing auth tokens.
 */
export function resetAllStores(): void {
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

  // Clear in-memory crypto caches (decrypted messages + sent-message cache)
  clearDecryptionCache()

  // Reset the IndexedDB adapter singleton so the next login
  // opens a user-scoped database
  resetStorage()

  // Reset all Zustand stores to initial state
  useMessageStore.setState({
    messagesByChannel: {},
    typingUsers: {},
    hasMore: {},
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

  useCryptoStore.setState({
    groupStates: {},
    groupSetupInProgress: {}
  })

  useServerStore.setState({
    servers: [],
    activeServerId: null,
    activeChannelId: null,
    members: []
  })

  useDmStore.setState({
    conversations: [],
    selectedConversationId: null
  })

  useUnreadStore.setState({
    channelUnreads: {},
    dmUnreads: {}
  })

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
