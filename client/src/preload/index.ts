import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { AuthRefreshResult } from '../shared/authSession'

interface EncryptedRoomDataKeyStorageRecord {
  room_id: string
  topology_generation: number
  epoch: number
  ciphertext: string
  nonce: string
}

interface ControlIntentStorageRecord {
  version: 1
  operation: string
  idempotency_key: string
  scope_id: string
  membership_generation: number
  payload_json: string
  attempts: number
  state: string
  result_json: string | null
  created_at: string
  updated_at: string
}

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
  getWorkspaceSnapshot: (userId: string) =>
    ipcRenderer.invoke('cryptoDb:getWorkspaceSnapshot', userId),
  setWorkspaceSnapshot: (
    userId: string,
    snapshot: {
      version: number
      token: string | null
      servers_json: string
      conversations_json: string
      unread_counts_json: string
      updated_at: string
    }
  ) => ipcRenderer.invoke('cryptoDb:setWorkspaceSnapshot', userId, snapshot),
  getRecoveryPackageKey: (userId: string) =>
    ipcRenderer.invoke('cryptoDb:getRecoveryPackageKey', userId),
  setRecoveryPackageKey: (userId: string, key: Uint8Array) =>
    ipcRenderer.invoke('cryptoDb:setRecoveryPackageKey', userId, key),

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
      room_data_keys?: EncryptedRoomDataKeyStorageRecord[]
      control_intents?: ControlIntentStorageRecord[]
    }
  ) =>
    ipcRenderer.invoke('cryptoDb:setScopeCheckpoint', groupId, checkpoint),
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
    thread_root_message_id: string | null
    reply_to_message_id: string | null
    is_reply: boolean
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
    ipcRenderer.invoke('cryptoDb:removeFromFtsIndex', messageId),

  // Pending message send outbox
  getPendingMessageSends: () =>
    ipcRenderer.invoke('cryptoDb:getPendingMessageSends'),
  setPendingMessageSend: (entry: {
    client_nonce: string
    scope_kind: 'channel' | 'dm'
    scope_id: string
    scope_channel_id: string | null
    payload_json: string
    inserted_at: string
  }) => ipcRenderer.invoke('cryptoDb:setPendingMessageSend', entry),
  deletePendingMessageSend: (clientNonce: string) =>
    ipcRenderer.invoke('cryptoDb:deletePendingMessageSend', clientNonce)
}

const authSessionApi = {
  setRefreshToken: (refreshToken: string, serverUrl: string): boolean =>
    ipcRenderer.sendSync('authSession:setRefreshToken', refreshToken, serverUrl) === true,
  clearRefreshToken: (): boolean =>
    ipcRenderer.sendSync('authSession:clearRefreshToken') === true,
  refreshAccessToken: (serverUrl: string): Promise<AuthRefreshResult> =>
    ipcRenderer.invoke('authSession:refreshAccessToken', serverUrl)
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

const attachmentMediaApi = {
  register: (registration: {
    attachmentId: string
    serverUrl: string
    accessToken: string
    contentType: string
    plaintextSize: number
    encryption: { v: 2; key: string; nonce_prefix: string }
  }): Promise<string> => ipcRenderer.invoke('attachmentMedia:register', registration),
  release: (url: string): Promise<boolean> => ipcRenderer.invoke('attachmentMedia:release', url),
  clear: (): Promise<void> => ipcRenderer.invoke('attachmentMedia:clear')
}

contextBridge.exposeInMainWorld('electron', electronAPI)
contextBridge.exposeInMainWorld('cryptoDb', cryptoDbApi)
contextBridge.exposeInMainWorld('authSession', authSessionApi)
contextBridge.exposeInMainWorld('notifications', notificationApi)
contextBridge.exposeInMainWorld('linkPreview', linkPreviewApi)
contextBridge.exposeInMainWorld('attachmentMedia', attachmentMediaApi)
