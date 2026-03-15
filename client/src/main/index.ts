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
  getIdentityKeys,
  setIdentityKeys,
  deleteIdentityKeys,
  getLocalKeyPackages,
  setLocalKeyPackages,
  consumeLocalKeyPackage,
  countLocalKeyPackages,
  cacheMessage,
  getCachedMessages,
  clearMessageCache,
  searchMessages,
  indexDecryptedMessage,
  removeFromFtsIndex
} from './db'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpcHandlers(): void {
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
        ciphertext: Uint8Array | null
        mls_epoch: number | null
        inserted_at: string
      }
    ) => cacheMessage({
      ...msg,
      ciphertext: msg.ciphertext ? Buffer.from(msg.ciphertext) : null
    })
  )
  ipcMain.handle('cryptoDb:getCachedMessages', (_, channelId: string) =>
    getCachedMessages(channelId)
  )
  ipcMain.handle('cryptoDb:clearMessageCache', (_, channelId: string) =>
    clearMessageCache(channelId)
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
}

function setupAutoUpdater(): void {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

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
