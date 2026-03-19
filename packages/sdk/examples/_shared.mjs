import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { configureCryptoStorage } from '../dist/storage/index.js'
import {
  createConversation,
  fetchScopesSync,
  fetchWorkspaceSync,
  getCurrentUser,
  listConversations,
  listServers,
  configureHttpClient,
  searchUsers
} from '../dist/api/index.js'
import { VesperSocketClient } from '../dist/transport/index.js'
import { VesperAuthClient } from '../dist/auth/index.js'

function slugify(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return normalized || 'sample'
}

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true })
}

function safeReadJson(filePath, fallback) {
  try {
    if (!existsSync(filePath)) {
      return fallback
    }

    const raw = readFileSync(filePath, 'utf8')
    return raw.trim() ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath))
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function bytesToBase64(value) {
  if (!value) {
    return null
  }

  return Buffer.from(value).toString('base64')
}

function base64ToArrayBuffer(value) {
  if (!value) {
    return null
  }

  const buffer = Buffer.from(value, 'base64')
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
}

function resolveSampleStateDir(deviceLabel, options = {}) {
  if (options.storageDir) {
    return options.storageDir
  }

  return path.join(homedir(), '.vesper-sdk-samples', slugify(deviceLabel))
}

function getSessionFilePath(baseDir) {
  return path.join(baseDir, 'session.json')
}

function getCryptoFilePath(baseDir, userId) {
  return path.join(baseDir, 'crypto', `${userId}.json`)
}

function createEmptyCryptoState() {
  return {
    nextKeyPackageId: 1,
    identityKeys: {},
    groupStates: {},
    groupSyncCursors: {},
    keyPackages: [],
    cachedMessages: {},
    cachedDecryptions: {},
    sentPlaintext: {},
    searchIndex: {}
  }
}

class FileSessionStore {
  constructor(serverUrl, filePath) {
    this.filePath = filePath
    this.state = safeReadJson(filePath, {
      serverUrl: serverUrl || null,
      accessToken: null,
      refreshToken: null,
      notice: null
    })

    if (serverUrl) {
      this.state.serverUrl = serverUrl
      this.persist()
    }
  }

  persist() {
    writeJson(this.filePath, this.state)
  }

  getServerUrl() {
    const serverUrl = String(this.state.serverUrl || '').trim()
    if (!serverUrl) {
      throw new Error(
        'Vesper base URL is not configured. Set VESPER_API_URL or provide a SessionStore with a server URL.'
      )
    }

    return serverUrl
  }

  setServerUrl(serverUrl) {
    this.state.serverUrl = serverUrl
    this.persist()
  }

  getAccessToken() {
    return this.state.accessToken || null
  }

  getRefreshToken() {
    return this.state.refreshToken || null
  }

  setTokens(accessToken, refreshToken) {
    this.state.accessToken = accessToken
    this.state.refreshToken = refreshToken
    this.persist()
  }

  clearTokens() {
    this.state.accessToken = null
    this.state.refreshToken = null
    this.persist()
  }

  setSessionNotice(notice) {
    this.state.notice = notice
    this.persist()
  }

  clearSessionNotice() {
    this.state.notice = null
    this.persist()
  }

  getSessionNotice() {
    return this.state.notice || null
  }

  emitSessionNotice() {}
}

class FileCryptoStorage {
  constructor(filePath) {
    this.filePath = filePath
    this.state = safeReadJson(filePath, createEmptyCryptoState())
  }

  persist() {
    writeJson(this.filePath, this.state)
  }

  async getIdentityKeys(userId) {
    const record = this.state.identityKeys[userId]
    if (!record) {
      return null
    }

    return {
      public_identity_key: base64ToArrayBuffer(record.public_identity_key),
      public_key_exchange: base64ToArrayBuffer(record.public_key_exchange),
      encrypted_private_keys: base64ToArrayBuffer(record.encrypted_private_keys),
      nonce: base64ToArrayBuffer(record.nonce),
      salt: base64ToArrayBuffer(record.salt),
      signature_private_key: base64ToArrayBuffer(record.signature_private_key)
    }
  }

  async setIdentityKeys(
    userId,
    publicIdentityKey,
    publicKeyExchange,
    encryptedPrivateKeys,
    nonce,
    salt,
    signaturePrivateKey = null
  ) {
    this.state.identityKeys[userId] = {
      public_identity_key: bytesToBase64(publicIdentityKey),
      public_key_exchange: bytesToBase64(publicKeyExchange),
      encrypted_private_keys: bytesToBase64(encryptedPrivateKeys),
      nonce: bytesToBase64(nonce),
      salt: bytesToBase64(salt),
      signature_private_key: bytesToBase64(signaturePrivateKey)
    }
    this.persist()
  }

  async deleteIdentityKeys(userId) {
    delete this.state.identityKeys[userId]
    this.persist()
  }

  async getGroupState(groupId) {
    const record = this.state.groupStates[groupId]
    if (!record) {
      return null
    }

    return {
      state: base64ToArrayBuffer(record.state),
      epoch: record.epoch
    }
  }

  async setGroupState(groupId, state, epoch) {
    this.state.groupStates[groupId] = {
      state: bytesToBase64(state),
      epoch
    }
    this.persist()
  }

  async deleteGroupState(groupId) {
    delete this.state.groupStates[groupId]
    delete this.state.groupSyncCursors[groupId]
    this.persist()
  }

  async getGroupSyncCursor(groupId) {
    return this.state.groupSyncCursors[groupId] || 0
  }

  async setGroupSyncCursor(groupId, lastEventSeq) {
    this.state.groupSyncCursors[groupId] = lastEventSeq
    this.persist()
  }

  async getLocalKeyPackages() {
    return this.state.keyPackages.map((record) => ({
      id: record.id,
      key_package_public: base64ToArrayBuffer(record.key_package_public),
      key_package_private: base64ToArrayBuffer(record.key_package_private)
    }))
  }

  async setLocalKeyPackages(packages) {
    for (const entry of packages) {
      this.state.keyPackages.push({
        id: this.state.nextKeyPackageId++,
        key_package_public: bytesToBase64(entry.publicData),
        key_package_private: bytesToBase64(entry.privateData)
      })
    }
    this.persist()
  }

  async consumeLocalKeyPackage(id) {
    this.state.keyPackages = this.state.keyPackages.filter((entry) => entry.id !== id)
    this.persist()
  }

  async countLocalKeyPackages() {
    return this.state.keyPackages.length
  }

  async cacheMessage(msg) {
    this.state.cachedMessages[msg.id] = {
      ...msg,
      ciphertext: bytesToBase64(msg.ciphertext)
    }
    this.persist()
  }

  async getCachedMessageDecryption(messageId) {
    return this.state.cachedDecryptions[messageId] || null
  }

  async setCachedMessageDecryption(messageId, plaintext) {
    this.state.cachedDecryptions[messageId] = plaintext
    this.persist()
  }

  async getCachedMessages(channelId) {
    return Object.values(this.state.cachedMessages)
      .filter((message) => message.channel_id === channelId || message.conversation_id === channelId)
      .map((message) => ({
        ...message,
        ciphertext: base64ToArrayBuffer(message.ciphertext)
      }))
  }

  async clearMessageCache(channelId) {
    for (const [messageId, message] of Object.entries(this.state.cachedMessages)) {
      if (message.channel_id === channelId || message.conversation_id === channelId) {
        delete this.state.cachedMessages[messageId]
        delete this.state.cachedDecryptions[messageId]
        delete this.state.searchIndex[messageId]
      }
    }
    this.persist()
  }

  async getSentMessagePlaintext(ciphertextB64) {
    return this.state.sentPlaintext[ciphertextB64] || null
  }

  async setSentMessagePlaintext(ciphertextB64, plaintext) {
    this.state.sentPlaintext[ciphertextB64] = plaintext
    this.persist()
  }

  async searchMessages(query, channelId) {
    const needle = String(query || '').trim().toLowerCase()

    return Object.values(this.state.searchIndex).filter((record) => {
      if (channelId && record.channel_id !== channelId) {
        return false
      }

      return record.preview.toLowerCase().includes(needle)
    })
  }

  async indexDecryptedMessage(messageId, channelId, content) {
    const cachedMessage = this.state.cachedMessages[messageId] || null

    this.state.searchIndex[messageId] = {
      message_id: messageId,
      channel_id: channelId,
      conversation_id: cachedMessage?.conversation_id || null,
      server_id: cachedMessage?.server_id || null,
      sender_id: cachedMessage?.sender_id || null,
      sender_username: cachedMessage?.sender_username || null,
      inserted_at: cachedMessage?.inserted_at || null,
      preview: content
    }
    this.persist()
  }

  async removeFromFtsIndex(messageId) {
    delete this.state.searchIndex[messageId]
    this.persist()
  }
}

export function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}

export function optionalEnv(name, fallback) {
  const value = process.env[name]?.trim()
  return value || fallback
}

export function createSampleDeviceIdentity(deviceLabel, overrides = {}) {
  const username = process.env.VESPER_USERNAME?.trim() || 'vesper'
  const deviceId =
    overrides.deviceId ||
    process.env.VESPER_DEVICE_ID?.trim() ||
    `sample-${slugify(username)}-${slugify(deviceLabel)}`
  const deviceName =
    overrides.deviceName ||
    process.env.VESPER_DEVICE_NAME?.trim() ||
    `SDK Sample ${deviceLabel}`

  return {
    id: deviceId,
    name: deviceName,
    platform: 'node'
  }
}

export function loadPersistedServerUrl(deviceLabel, options = {}) {
  const baseDir = resolveSampleStateDir(deviceLabel, options)
  const session = safeReadJson(getSessionFilePath(baseDir), {
    serverUrl: null
  })
  return typeof session.serverUrl === 'string' ? session.serverUrl : null
}

export function createSdkHarness(deviceLabel, options = {}) {
  const apiUrl =
    normalizePersistedServerUrl(requiredEnv('VESPER_API_URL')) ||
    requiredEnv('VESPER_API_URL')
  const baseDir = resolveSampleStateDir(deviceLabel, options)
  const sessionStore = new FileSessionStore(apiUrl, getSessionFilePath(baseDir))
  const deviceIdentity =
    options.deviceIdentity || createSampleDeviceIdentity(deviceLabel, options)

  configureHttpClient({
    fetchImpl: fetch,
    sessionStore
  })
  configureCryptoStorage((userId) => new FileCryptoStorage(getCryptoFilePath(baseDir, userId)))

  const auth = new VesperAuthClient({
    getDeviceIdentity: () => deviceIdentity
  })

  return {
    apiUrl,
    auth,
    baseDir,
    deviceIdentity,
    sessionStore,
    socket: new VesperSocketClient({
      getAccessToken: () => sessionStore.getAccessToken(),
      getServerUrl: () => sessionStore.getServerUrl()
    })
  }
}

function normalizePersistedServerUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

export async function registerOrLogin(auth, username, password) {
  try {
    return await auth.register(username, password)
  } catch (error) {
    if (
      error instanceof Error &&
      /username|taken|exists|already/i.test(error.message)
    ) {
      return await auth.login(username, password)
    }

    throw error
  }
}

export {
  createConversation,
  fetchScopesSync,
  fetchWorkspaceSync,
  getCurrentUser,
  listConversations,
  listServers,
  searchUsers
}
