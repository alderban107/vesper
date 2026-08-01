import { app, shell, BrowserWindow, ipcMain, Notification, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import {
  initDb,
  closeDb,
  getGroupState,
  setGroupState,
  deleteGroupState,
  getGroupSyncCursor,
  setGroupSyncCursor,
  getScopeCheckpoint,
  setScopeCheckpoint,
  getIdentityKeys,
  setIdentityKeys,
  deleteIdentityKeys,
  getWorkspaceSnapshot,
  setWorkspaceSnapshot,
  getRecoveryPackageKey,
  setRecoveryPackageKey,
  getLocalKeyPackages,
  setLocalKeyPackages,
  consumeLocalKeyPackage,
  countLocalKeyPackages,
  cacheMessage,
  getCachedMessageDecryption,
  setCachedMessageDecryption,
  getCachedMessages,
  clearMessageCache,
  getSentMessagePlaintext,
  setSentMessagePlaintext,
  searchMessages,
  indexDecryptedMessage,
  removeFromFtsIndex,
  getPendingMessageSends,
  setPendingMessageSend,
  deletePendingMessageSend,
  getRefreshToken as getStoredRefreshToken,
  setRefreshToken as setStoredRefreshToken,
  clearRefreshToken as clearStoredRefreshToken
} from './db'
import { fetchLinkPreviewMetadata } from './linkPreviewFetcher'
import {
  classifyRefreshHttpFailure,
  type AuthRefreshResult
} from '../shared/authSession'
import {
  isAllowedExternalUrl,
  isAllowedRendererNavigation,
  normalizeHttpOrigin,
  secureWebPreferences
} from './electronSecurity'

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

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: secureWebPreferences(join(__dirname, '../preload/index.js'))
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isAllowedExternalUrl(details.url)) {
      void shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedRendererNavigation(mainWindow.webContents.getURL(), targetUrl)) {
      event.preventDefault()
    }
  })

  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpcHandlers(): void {
  ipcMain.on(
    'authSession:setRefreshToken',
    (event, refreshToken: unknown, rawServerUrl: unknown) => {
      const serverOrigin =
        typeof rawServerUrl === 'string' ? normalizeHttpOrigin(rawServerUrl) : null
      if (
        typeof refreshToken !== 'string' ||
        refreshToken.length === 0 ||
        refreshToken.length > 8192 ||
        !serverOrigin
      ) {
        event.returnValue = false
        return
      }
      setStoredRefreshToken(refreshToken, serverOrigin)
      event.returnValue = true
    }
  )

  ipcMain.on('authSession:clearRefreshToken', (event) => {
    clearStoredRefreshToken()
    event.returnValue = true
  })

  ipcMain.handle(
    'authSession:refreshAccessToken',
    async (_event, rawServerUrl: unknown): Promise<AuthRefreshResult> => {
      const serverOrigin =
        typeof rawServerUrl === 'string' ? normalizeHttpOrigin(rawServerUrl) : null
      const refreshToken = serverOrigin ? getStoredRefreshToken(serverOrigin) : null
      if (!refreshToken || !serverOrigin || typeof rawServerUrl !== 'string') {
        return { status: 'invalid' }
      }

      try {
        const endpoint = new URL('/api/v1/auth/refresh', rawServerUrl)
        const response = await fetch(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken }),
          signal: AbortSignal.timeout(10_000)
        })
        if (!response.ok) {
          const failure = classifyRefreshHttpFailure(response.status)
          if (failure === 'invalid') {
            clearStoredRefreshToken()
          }
          return { status: failure }
        }

        const payload = (await response.json()) as {
          access_token?: unknown
          refresh_token?: unknown
        }
        if (
          typeof payload.access_token !== 'string' ||
          typeof payload.refresh_token !== 'string' ||
          payload.access_token.length === 0 ||
          payload.refresh_token.length === 0 ||
          payload.access_token.length > 8192 ||
          payload.refresh_token.length > 8192
        ) {
          return { status: 'retryable' }
        }

        setStoredRefreshToken(payload.refresh_token, serverOrigin)
        return { status: 'ok', accessToken: payload.access_token }
      } catch {
        return { status: 'retryable' }
      }
    }
  )

  // Identity keys
  ipcMain.handle('cryptoDb:getIdentityKeys', (_, userId: string) =>
    getIdentityKeys(userId)
  )
  ipcMain.handle(
    'cryptoDb:setIdentityKeys',
    (
      _,
      userId: string,
      publicIdentityKey: Buffer,
      publicKeyExchange: Buffer,
      encryptedPrivateKeys: Buffer,
      nonce: Buffer,
      salt: Buffer,
      signaturePrivateKey: Buffer | null
    ) => setIdentityKeys(userId, publicIdentityKey, publicKeyExchange, encryptedPrivateKeys, nonce, salt, signaturePrivateKey ?? null)
  )
  ipcMain.handle('cryptoDb:deleteIdentityKeys', (_, userId: string) =>
    deleteIdentityKeys(userId)
  )
  ipcMain.handle('cryptoDb:getWorkspaceSnapshot', (_, userId: string) =>
    getWorkspaceSnapshot(userId)
  )
  ipcMain.handle(
    'cryptoDb:setWorkspaceSnapshot',
    (
      _,
      userId: string,
      snapshot: {
        version: number
        token: string | null
        servers_json: string
        conversations_json: string
        unread_counts_json: string
        updated_at: string
      }
    ) => setWorkspaceSnapshot(userId, snapshot)
  )
  ipcMain.handle('cryptoDb:getRecoveryPackageKey', (_, userId: string) =>
    getRecoveryPackageKey(userId)
  )
  ipcMain.handle(
    'cryptoDb:setRecoveryPackageKey',
    (_, userId: string, key: Buffer) => setRecoveryPackageKey(userId, key)
  )

  // MLS groups
  ipcMain.handle('cryptoDb:getGroupState', (_, groupId: string) =>
    getGroupState(groupId)
  )
  ipcMain.handle(
    'cryptoDb:setGroupState',
    (_, groupId: string, state: Buffer, epoch: number) =>
      setGroupState(groupId, state, epoch)
  )
  ipcMain.handle('cryptoDb:deleteGroupState', (_, groupId: string) =>
    deleteGroupState(groupId)
  )
  ipcMain.handle('cryptoDb:getGroupSyncCursor', (_, groupId: string) =>
    getGroupSyncCursor(groupId)
  )
  ipcMain.handle(
    'cryptoDb:setGroupSyncCursor',
    (_, groupId: string, lastEventSeq: number) =>
      setGroupSyncCursor(groupId, lastEventSeq)
  )
  ipcMain.handle('cryptoDb:getScopeCheckpoint', (_, groupId: string) =>
    getScopeCheckpoint(groupId)
  )
  ipcMain.handle('cryptoDb:getKnownScopeIds', () =>
    getKnownScopeIds()
  )
  ipcMain.handle(
    'cryptoDb:setScopeCheckpoint',
    (
      _,
      groupId: string,
      checkpoint: {
        state: Buffer | null
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
    ) => setScopeCheckpoint(groupId, checkpoint)
  )
  // Key packages
  ipcMain.handle('cryptoDb:getLocalKeyPackages', () => getLocalKeyPackages())
  ipcMain.handle(
    'cryptoDb:setLocalKeyPackages',
    (_, packages: Array<{ publicData: Buffer; privateData: Buffer }>) =>
      setLocalKeyPackages(packages)
  )
  ipcMain.handle('cryptoDb:consumeLocalKeyPackage', (_, id: number) =>
    consumeLocalKeyPackage(id)
  )
  ipcMain.handle('cryptoDb:countLocalKeyPackages', () =>
    countLocalKeyPackages()
  )

  // Voice notifications
  ipcMain.handle(
    'voice:showCallNotification',
    (_, data: { callerId: string; conversationId: string }) => {
      if (Notification.isSupported()) {
        const notification = new Notification({
          title: 'Incoming Voice Call',
          body: `Someone is calling you`
        })
        notification.show()

        // Focus the window when notification is clicked
        notification.on('click', () => {
          const windows = BrowserWindow.getAllWindows()
          if (windows.length > 0) {
            const win = windows[0]
            if (win.isMinimized()) win.restore()
            win.focus()
          }
        })
      }
    }
  )

  // Message notifications
  ipcMain.handle(
    'message:showNotification',
    (_, data: { title: string; body: string; channelId?: string; conversationId?: string }) => {
      if (Notification.isSupported()) {
        const notification = new Notification({
          title: data.title,
          body: data.body
        })
        notification.show()

        notification.on('click', () => {
          const windows = BrowserWindow.getAllWindows()
          if (windows.length > 0) {
            const win = windows[0]
            if (win.isMinimized()) win.restore()
            win.focus()
            // Send navigation event to renderer
            win.webContents.send('notification:navigate', {
              channelId: data.channelId,
              conversationId: data.conversationId
            })
          }
        })
      }
    }
  )

  // Message cache (stores ciphertext, not plaintext)
  ipcMain.handle(
    'cryptoDb:cacheMessage',
    (
      _,
      msg: {
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
      }
    ) => cacheMessage({
      ...msg,
      ciphertext: msg.ciphertext ? Buffer.from(msg.ciphertext) : null
    })
  )
  ipcMain.handle('cryptoDb:getCachedMessageDecryption', (_, messageId: string) =>
    getCachedMessageDecryption(messageId)
  )
  ipcMain.handle(
    'cryptoDb:setCachedMessageDecryption',
    (_, messageId: string, plaintext: string) =>
      setCachedMessageDecryption(messageId, plaintext)
  )
  ipcMain.handle('cryptoDb:getCachedMessages', (_, channelId: string) =>
    getCachedMessages(channelId)
  )
  ipcMain.handle('cryptoDb:clearMessageCache', (_, channelId: string) =>
    clearMessageCache(channelId)
  )
  ipcMain.handle('cryptoDb:getSentMessagePlaintext', (_, ciphertextB64: string) =>
    getSentMessagePlaintext(ciphertextB64)
  )
  ipcMain.handle(
    'cryptoDb:setSentMessagePlaintext',
    (_, ciphertextB64: string, plaintext: string) =>
      setSentMessagePlaintext(ciphertextB64, plaintext)
  )

  // Message search (FTS5)
  ipcMain.handle('cryptoDb:searchMessages', (_, query: string, channelId?: string) =>
    searchMessages(query, channelId)
  )

  // FTS5 index management
  ipcMain.handle(
    'cryptoDb:indexDecryptedMessage',
    (_, messageId: string, channelId: string, content: string) =>
      indexDecryptedMessage(messageId, channelId, content)
  )
  ipcMain.handle('cryptoDb:removeFromFtsIndex', (_, messageId: string) =>
    removeFromFtsIndex(messageId)
  )

  // Pending message send outbox
  ipcMain.handle('cryptoDb:getPendingMessageSends', () => getPendingMessageSends())
  ipcMain.handle(
    'cryptoDb:setPendingMessageSend',
    (
      _,
      entry: {
        client_nonce: string
        scope_kind: 'channel' | 'dm'
        scope_id: string
        scope_channel_id: string | null
        payload_json: string
        inserted_at: string
      }
    ) => setPendingMessageSend(entry)
  )
  ipcMain.handle('cryptoDb:deletePendingMessageSend', (_, clientNonce: string) =>
    deletePendingMessageSend(clientNonce)
  )

  ipcMain.handle('linkPreview:fetchMetadata', (_, url: string) =>
    fetchLinkPreviewMetadata(url)
  )
}

function setupAutoUpdater(): void {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = true // Include nightly prerelease builds

  autoUpdater.on('update-available', (info) => {
    const notification = new Notification({
      title: 'Update Available',
      body: `Version ${info.version} is available and downloading.`
    })
    notification.show()
  })

  autoUpdater.on('update-downloaded', () => {
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Update Ready',
        message: 'A new version has been downloaded. Restart to apply the update.',
        buttons: ['Restart Now', 'Later']
      })
      .then((result) => {
        if (result.response === 0) {
          autoUpdater.quitAndInstall()
        }
      })
  })

  // Check for updates — silently fail in dev
  autoUpdater.checkForUpdatesAndNotify().catch(() => {})
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.vesper')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  initDb()
  registerIpcHandlers()

  createWindow()

  // Check for updates in production
  if (!is.dev) {
    setupAutoUpdater()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  closeDb()
})
