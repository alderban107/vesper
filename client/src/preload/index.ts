import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const cryptoDbApi = {
  // Identity keys
  getIdentityKeys: (userId: string) =>
    ipcRenderer.invoke('cryptoDb:getIdentityKeys', userId),
  setIdentityKeys: (
    userId: string,
    publicIdentityKey: Uint8Array,
    publicKeyExchange: Uint8Array,
    encryptedPrivateKeys: Uint8Array,
    nonce: Uint8Array,
    salt: Uint8Array,
    signaturePrivateKey?: Uint8Array | null
  ) =>
    ipcRenderer.invoke(
      'cryptoDb:setIdentityKeys',
      userId,
      publicIdentityKey,
      publicKeyExchange,
      encryptedPrivateKeys,
      nonce,
      salt,
      signaturePrivateKey ?? null
    ),
  deleteIdentityKeys: (userId: string) =>
    ipcRenderer.invoke('cryptoDb:deleteIdentityKeys', userId),

  // MLS groups
  getGroupState: (groupId: string) =>
    ipcRenderer.invoke('cryptoDb:getGroupState', groupId),
  setGroupState: (groupId: string, state: Uint8Array, epoch: number) =>
    ipcRenderer.invoke('cryptoDb:setGroupState', groupId, state, epoch),
  deleteGroupState: (groupId: string) =>
    ipcRenderer.invoke('cryptoDb:deleteGroupState', groupId),
  getGroupSyncCursor: (groupId: string) =>
    ipcRenderer.invoke('cryptoDb:getGroupSyncCursor', groupId),
  setGroupSyncCursor: (groupId: string, lastEventSeq: number) =>
    ipcRenderer.invoke('cryptoDb:setGroupSyncCursor', groupId, lastEventSeq),
  getScopeCheckpoint: (groupId: string) =>
    ipcRenderer.invoke('cryptoDb:getScopeCheckpoint', groupId),
  getKnownScopeIds: () =>
    ipcRenderer.invoke('cryptoDb:getKnownScopeIds'),
  setScopeCheckpoint: (
    groupId: string,
    checkpoint: {
      state: Uint8Array | null
      epoch: number
      last_event_seq: number
      recent_commit_fingerprints?: string[]
      recent_history_bundle_fingerprints?: string[]
      repair_status?: string | null
      repair_failure_count?: number
      repair_last_error?: string | null
      repair_updated_at?: string | null
      pending_group_info_publish?: {
        group_info_data: Uint8Array
        ratchet_tree_data: Uint8Array | null
        epoch: number
      } | null
      pending_external_commit_broadcast?: {
        commit_data: string
        commit_id: string
      } | null
      pending_sponsored_transition?: {
        recipient_id: string
        recipient_client_id: string | null
        recipient_key_package_ref: string | null
        commit_data: string
        commit_id: string
        remove_commit_data: string | null
        welcome_data: string | null
        group_info_data: Uint8Array | null
        ratchet_tree_data: Uint8Array | null
        epoch: number | null
        previous_epoch: number | null
        base_state: Uint8Array | null
        base_epoch: number | null
      } | null
    }
  ) =>
    ipcRenderer.invoke('cryptoDb:setScopeCheckpoint', groupId, checkpoint),
  getPendingGroupInfoPublishes: () =>
    ipcRenderer.invoke('cryptoDb:getPendingGroupInfoPublishes'),
  setPendingGroupInfoPublish: (
    groupId: string,
    groupInfoData: Uint8Array,
    ratchetTreeData: Uint8Array | null,
    epoch: number
  ) =>
    ipcRenderer.invoke(
      'cryptoDb:setPendingGroupInfoPublish',
      groupId,
      groupInfoData,
      ratchetTreeData,
      epoch
    ),
  deletePendingGroupInfoPublish: (groupId: string) =>
    ipcRenderer.invoke('cryptoDb:deletePendingGroupInfoPublish', groupId),
  getPendingExternalCommitBroadcasts: () =>
    ipcRenderer.invoke('cryptoDb:getPendingExternalCommitBroadcasts'),
  getPendingSponsoredTransitions: () =>
    ipcRenderer.invoke('cryptoDb:getPendingSponsoredTransitions'),
  setPendingExternalCommitBroadcast: (
    groupId: string,
    commitData: string,
    commitId: string
  ) =>
    ipcRenderer.invoke(
      'cryptoDb:setPendingExternalCommitBroadcast',
      groupId,
      commitData,
      commitId
    ),
  deletePendingExternalCommitBroadcast: (groupId: string) =>
    ipcRenderer.invoke('cryptoDb:deletePendingExternalCommitBroadcast', groupId),

  // Key packages
  getLocalKeyPackages: () =>
    ipcRenderer.invoke('cryptoDb:getLocalKeyPackages'),
  setLocalKeyPackages: (
    packages: Array<{ publicData: Uint8Array; privateData: Uint8Array }>
  ) => ipcRenderer.invoke('cryptoDb:setLocalKeyPackages', packages),
  consumeLocalKeyPackage: (id: number) =>
    ipcRenderer.invoke('cryptoDb:consumeLocalKeyPackage', id),
  countLocalKeyPackages: () =>
    ipcRenderer.invoke('cryptoDb:countLocalKeyPackages'),

  // Message cache (stores ciphertext, not plaintext)
  cacheMessage: (msg: {
    id: string
    channel_id: string | null
    conversation_id: string | null
    server_id: string | null
    sender_id: string | null
    sender_username: string | null
    parent_message_id: string | null
    ciphertext: Uint8Array | null
    decrypted_content: string | null
    mls_epoch: number | null
    inserted_at: string
  }) => ipcRenderer.invoke('cryptoDb:cacheMessage', msg),
  getCachedMessageDecryption: (messageId: string) =>
    ipcRenderer.invoke('cryptoDb:getCachedMessageDecryption', messageId),
  setCachedMessageDecryption: (messageId: string, plaintext: string) =>
    ipcRenderer.invoke('cryptoDb:setCachedMessageDecryption', messageId, plaintext),
  getCachedMessages: (channelId: string) =>
    ipcRenderer.invoke('cryptoDb:getCachedMessages', channelId),
  clearMessageCache: (channelId: string) =>
    ipcRenderer.invoke('cryptoDb:clearMessageCache', channelId),
  getSentMessagePlaintext: (ciphertextB64: string) =>
    ipcRenderer.invoke('cryptoDb:getSentMessagePlaintext', ciphertextB64),
  setSentMessagePlaintext: (ciphertextB64: string, plaintext: string) =>
    ipcRenderer.invoke('cryptoDb:setSentMessagePlaintext', ciphertextB64, plaintext),

  // FTS5 full-text search
  searchMessages: (query: string, channelId?: string) =>
    ipcRenderer.invoke('cryptoDb:searchMessages', query, channelId),
  indexDecryptedMessage: (messageId: string, channelId: string, content: string) =>
    ipcRenderer.invoke('cryptoDb:indexDecryptedMessage', messageId, channelId, content),
  removeFromFtsIndex: (messageId: string) =>
    ipcRenderer.invoke('cryptoDb:removeFromFtsIndex', messageId)
}

const notificationApi = {
  showMessageNotification: (data: {
    title: string
    body: string
    channelId?: string
    conversationId?: string
  }) => ipcRenderer.invoke('message:showNotification', data),

  onNavigate: (callback: (data: { channelId?: string; conversationId?: string }) => void) => {
    ipcRenderer.on('notification:navigate', (_, data) => callback(data))
  }
}

const linkPreviewApi = {
  fetchMetadata: (url: string) =>
    ipcRenderer.invoke('linkPreview:fetchMetadata', url)
}

contextBridge.exposeInMainWorld('electron', electronAPI)
contextBridge.exposeInMainWorld('cryptoDb', cryptoDbApi)
contextBridge.exposeInMainWorld('notifications', notificationApi)
contextBridge.exposeInMainWorld('linkPreview', linkPreviewApi)
