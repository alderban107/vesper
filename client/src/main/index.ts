import { app, shell, BrowserWindow, ipcMain, Notification, dialog } from 'electron'
import { lookup } from 'node:dns/promises'
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
  getCachedMessageDecryption,
  setCachedMessageDecryption,
  getCachedMessages,
  clearMessageCache,
  getSentMessagePlaintext,
  setSentMessagePlaintext,
  searchMessages,
  indexDecryptedMessage,
  removeFromFtsIndex
} from './db'
import {
  isBlockedLinkPreviewUrl,
  parseLinkPreview,
  type LinkPreviewData
} from '../shared/linkPreview'

const LINK_PREVIEW_TIMEOUT_MS = 5_000
const MAX_LINK_PREVIEW_HTML_LENGTH = 524_288

function isPrivateIpAddress(address: string): boolean {
  if (address === '::1') {
    return true
  }

  if (address.startsWith('fe80:') || address.startsWith('fc') || address.startsWith('fd')) {
    return true
  }

  const match = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!match) {
    return false
  }

  const [a, b] = match.slice(1).map(Number)
  if ([a, b].some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true
  }

  if (a === 10 || a === 127 || a === 0) {
    return true
  }

  if (a === 169 && b === 254) {
    return true
  }

  if (a === 172 && b >= 16 && b <= 31) {
    return true
  }

  if (a === 192 && b === 168) {
    return true
  }

  return false
}

async function isSafeLinkPreviewUrl(rawUrl: string): Promise<boolean> {
  if (isBlockedLinkPreviewUrl(rawUrl)) {
    return false
  }

  try {
    const url = new URL(rawUrl)
    const addresses = await lookup(url.hostname, { all: true })
    return addresses.every((entry) => !isPrivateIpAddress(entry.address))
  } catch {
    return false
  }
}

async function fetchLinkPreviewMetadata(rawUrl: string): Promise<LinkPreviewData | null> {
  if (!(await isSafeLinkPreviewUrl(rawUrl))) {
    return null
  }

  try {
    const response = await fetch(rawUrl, {
      signal: AbortSignal.timeout(LINK_PREVIEW_TIMEOUT_MS),
      redirect: 'follow'
    })

    if (!response.ok) {
      return null
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      return null
    }

    const finalUrl = response.url || rawUrl
    if (!(await isSafeLinkPreviewUrl(finalUrl))) {
      return null
    }

    const html = (await response.text()).slice(0, MAX_LINK_PREVIEW_HTML_LENGTH)
    return parseLinkPreview(html, finalUrl)
  } catch {
    return null
  }
}

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

  ipcMain.handle('linkPreview:fetchMetadata', (_, url: string) =>
    fetchLinkPreviewMetadata(url)
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
