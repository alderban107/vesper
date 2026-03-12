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
    salt: Uint8Array
  ) =>
    ipcRenderer.invoke(
      'cryptoDb:setIdentityKeys',
      userId,
      publicIdentityKey,
      publicKeyExchange,
      encryptedPrivateKeys,
      nonce,
      salt
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

  // Message cache
  cacheMessage: (msg: {
    id: string
    channel_id: string | null
    conversation_id: string | null
    server_id: string | null
    sender_id: string | null
    sender_username: string | null
    content: string | null
    attachment_filenames: string[]
    inserted_at: string
  }) => ipcRenderer.invoke('cryptoDb:cacheMessage', msg),
  getCachedMessages: (channelId: string) =>
    ipcRenderer.invoke('cryptoDb:getCachedMessages', channelId),
  getAllCachedMessages: () =>
    ipcRenderer.invoke('cryptoDb:getAllCachedMessages'),
  clearMessageCache: (channelId: string) =>
    ipcRenderer.invoke('cryptoDb:clearMessageCache', channelId),
  deleteCachedMessage: (messageId: string) =>
    ipcRenderer.invoke('cryptoDb:deleteCachedMessage', messageId),
  pruneMessageCache: (maxRows: number) =>
    ipcRenderer.invoke('cryptoDb:pruneMessageCache', maxRows)
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

contextBridge.exposeInMainWorld('electron', electronAPI)
contextBridge.exposeInMainWorld('cryptoDb', cryptoDbApi)
contextBridge.exposeInMainWorld('notifications', notificationApi)
