import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import path from 'node:path'

import {
  ackPendingWelcome,
  fetchKeyPackage,
  fetchPendingWelcomes,
  uint8ToBase64
} from '../../dist/api/index.js'
import {
  addMemberToGroup,
  buildClientCredentialIdentity,
  createKeyPackageBatch,
  createMLSGroup,
  decodeKeyPackageBytes,
  decodePayload,
  decryptMessage,
  deserializeGroupState,
  deserializePrivatePackage,
  encodePayload,
  encryptMessage,
  getDisplayText,
  getGroupLeafIdentities,
  groupHasMember,
  initCipherSuite,
  processCommitMessage,
  processWelcome,
  serializeGroupState
} from '../../dist/crypto/index.js'
import {
  consumeKeyPackage,
  loadGroupState,
  loadKeyPackages,
  saveGroupState
} from '../../dist/storage/index.js'
import {
  VesperStorage,
  createFileSessionStore,
  createVesperClient
} from '../../dist/index.js'
import { createSampleDeviceIdentity } from '../_shared.mjs'

const MAX_MESSAGES_PER_SCOPE = 120
const MAX_EVENTS = 100
const JOIN_WAIT_MS = 2_500
const RECENT_JOIN_REQUEST_TTL_MS = 2_500
const ENCRYPTED_UNAVAILABLE_PLACEHOLDER = '[Encrypted message unavailable]'

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function nowStamp() {
  return new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function parseTimestamp(value) {
  const parsed = Date.parse(value || '')
  return Number.isNaN(parsed) ? 0 : parsed
}

function slugify(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return normalized || 'sample'
}

function resolveSampleStateDir(deviceLabel) {
  return path.join(homedir(), '.vesper-sdk-samples', slugify(deviceLabel))
}

function shortId(value) {
  if (!value) {
    return 'n/a'
  }

  return value.length > 12 ? `${value.slice(0, 8)}...` : value
}

function scopeTopic(scope) {
  return scope.kind === 'channel'
    ? `chat:channel:${scope.id}`
    : `dm:${scope.id}`
}

function sortMessages(messages) {
  return [...messages].sort((left, right) => {
    const timeDelta = parseTimestamp(left.insertedAt) - parseTimestamp(right.insertedAt)
    if (timeDelta !== 0) {
      return timeDelta
    }

    return left.id.localeCompare(right.id)
  })
}

function sortRawMessages(rawMessages) {
  return [...rawMessages].sort((left, right) => {
    const leftSeq = typeof left.room_seq === 'number' ? left.room_seq : null
    const rightSeq = typeof right.room_seq === 'number' ? right.room_seq : null

    if (leftSeq !== null && rightSeq !== null && leftSeq !== rightSeq) {
      return leftSeq - rightSeq
    }

    const timeDelta = parseTimestamp(left.inserted_at) - parseTimestamp(right.inserted_at)
    if (timeDelta !== 0) {
      return timeDelta
    }

    return left.id.localeCompare(right.id)
  })
}

function coerceTextPayload(plaintext) {
  try {
    return getDisplayText(decodePayload(plaintext))
  } catch {
    return plaintext
  }
}

function mergeById(existing, incoming) {
  const merged = new Map()

  for (const entry of existing) {
    merged.set(entry.id, entry)
  }

  for (const entry of incoming) {
    const prior = merged.get(entry.id) || {}
    merged.set(entry.id, {
      ...prior,
      ...entry
    })
  }

  return [...merged.values()]
}

function applyConversationResets(conversations, resets) {
  if (!Array.isArray(resets) || resets.length === 0) {
    return conversations
  }

  return conversations.map((conversation) => {
    const reset = resets.find((entry) => entry.conversation_id === conversation.id)
    if (!reset) {
      return conversation
    }

    return {
      ...conversation,
      last_message: reset.last_message || null
    }
  })
}

function applyChannelActivity(servers, activity) {
  if (!Array.isArray(activity) || activity.length === 0) {
    return servers
  }

  const activityByChannelId = new Map(
    activity.map((entry) => [entry.channel_id, entry])
  )

  return servers.map((server) => ({
    ...server,
    channels: (server.channels || []).map((channel) => {
      const patch = activityByChannelId.get(channel.id)
      if (!patch) {
        return channel
      }

      return {
        ...channel,
        last_message_id: patch.message_id || null,
        last_message_inserted_at: patch.inserted_at || null,
        last_message_sender: patch.sender || null
      }
    })
  }))
}

function setUnreadCount(unreadCounts, kind, scopeId, count) {
  if (!scopeId || !Number.isFinite(count)) {
    return unreadCounts
  }

  const key = kind === 'channel' ? 'channels' : 'conversations'
  return {
    ...unreadCounts,
    [key]: {
      ...unreadCounts[key],
      [scopeId]: Math.max(0, Math.trunc(count))
    }
  }
}

function incrementUnreadCount(unreadCounts, kind, scopeId, delta = 1) {
  if (!scopeId || !Number.isFinite(delta)) {
    return unreadCounts
  }

  const key = kind === 'channel' ? 'channels' : 'conversations'
  const nextValue = Math.max(0, (unreadCounts[key][scopeId] || 0) + Math.trunc(delta))

  return {
    ...unreadCounts,
    [key]: {
      ...unreadCounts[key],
      [scopeId]: nextValue
    }
  }
}

function highestRoomSeq(messages) {
  let highest = null

  for (const message of messages) {
    const roomSeq = typeof message?.raw?.room_seq === 'number' ? message.raw.room_seq : null
    if (roomSeq == null) {
      continue
    }

    if (highest == null || roomSeq > highest) {
      highest = roomSeq
    }
  }

  return highest
}

export class VesperChatRuntime extends EventEmitter {
  constructor(options = {}) {
    super()

    this.baseUrl = options.baseUrl || process.env.VESPER_API_URL?.trim() || null
    if (!this.baseUrl) {
      throw new Error('VesperChatRuntime needs a server URL.')
    }

    this.deviceLabel = options.deviceLabel || 'opentui-chat'
    this.deviceId = options.deviceId || process.env.VESPER_DEVICE_ID?.trim() || null
    this.deviceName =
      options.deviceName || process.env.VESPER_DEVICE_NAME?.trim() || 'SDK Sample OpenTUI Chat'
    this.deviceIdentity =
      options.deviceIdentity || createSampleDeviceIdentity(this.deviceLabel, options)

    const baseDir = resolveSampleStateDir(this.deviceLabel)
    this.client = createVesperClient({
      baseUrl: this.baseUrl,
      sessionStore: createFileSessionStore(path.join(baseDir, 'session.json'), this.baseUrl),
      storage: (userId) =>
        new VesperStorage.FileCryptoStorage(path.join(baseDir, 'crypto', `${userId}.json`)),
      auth: {
        getDeviceIdentity: () => this.deviceIdentity
      }
    })
    this.chat = this.client.createEncryptedChat()

    this.session = null
    this.workspace = {
      user: null,
      currentDevice: null,
      devices: [],
      servers: [],
      conversations: [],
      canUseE2EE: false,
      syncToken: null,
      unreadCounts: {
        channels: {},
        conversations: {}
      }
    }

    this.scopeMessages = new Map()
    this.scopeHasMore = new Map()
    this.joinedTopics = new Set()
    this.userTopic = null
    this.activeScope = null
    this.groupStates = new Map()
    this.pendingCommits = new Map()
    this.recentJoinRequests = new Map()
    this.recentHandledJoinRequests = new Map()
    this.transcriptEvents = []

    this.client.subscribe(() => {
      this.syncWorkspaceFromClient()
    })
    this.client.on('raw', ({ event, payload }) => {
      void this.handleUserEvent(event, payload).catch(() => {})
    })
  }

  get user() {
    return this.workspace.user
  }

  get currentDevice() {
    return this.workspace.currentDevice
  }

  get devices() {
    return this.workspace.devices
  }

  get servers() {
    return this.workspace.servers
  }

  get conversations() {
    return this.workspace.conversations
  }

  get canUseE2EE() {
    return this.workspace.canUseE2EE
  }

  syncWorkspaceFromClient() {
    const state = this.client.getState()
    this.workspace = {
      user: state.user,
      currentDevice: state.currentDevice,
      devices: state.devices,
      servers: state.servers,
      conversations: state.conversations,
      canUseE2EE: state.canUseE2EE,
      syncToken: state.syncToken,
      unreadCounts: state.unreadCounts
    }
    this.userTopic = state.user ? `user:${state.user.id}` : null
    this.emitWorkspace()
  }

  async register(username, password) {
    this.session = await this.client.register(username, password)
    await this.finishAuth()
    return this.session
  }

  async restoreSession() {
    this.session = await this.client.restoreSession()
    if (!this.session) {
      return null
    }

    await this.finishAuth()
    return this.session
  }

  async login(username, password) {
    this.session = await this.client.login(username, password)
    await this.finishAuth()
    return this.session
  }

  async recoverAccount(mnemonic, newPassword) {
    this.session = await this.client.recoverAccount(mnemonic, newPassword)
    await this.finishAuth()
    return this.session
  }

  async approveCurrentDeviceWithRecovery(mnemonic) {
    await this.client.approveCurrentDeviceWithRecovery(mnemonic)
    this.session = this.client.getAuthSession()
    await this.finishAuth()
    return this.session
  }

  async unlockTrustedDevice(password) {
    if (!this.workspace.user) {
      throw new Error('No active session to unlock')
    }

    await this.client.unlockTrustedDevice(password)
    this.session = this.client.getAuthSession()
    await this.finishAuth()
    return this.session
  }

  async logout() {
    await this.client.logout().catch(() => {})
    this.session = null
    this.scopeMessages.clear()
    this.scopeHasMore.clear()
    this.joinedTopics.clear()
    this.activeScope = null
    this.userTopic = null
    this.groupStates.clear()
    this.pendingCommits.clear()
    this.chat.reset()
    this.syncWorkspaceFromClient()
  }

  async finishAuth() {
    await this.client.start(true)
    this.session = this.client.getAuthSession()
    if (this.client.getState().canUseE2EE) {
      await this.client.replenishKeyPackages()
    }
    this.syncWorkspaceFromClient()
  }

  async refreshWorkspace(forceFull = false) {
    if (!this.client.getState().user) {
      return
    }

    await Promise.all([this.client.syncNow(forceFull), this.client.fetchDevices()])
    this.syncWorkspaceFromClient()
  }

  emitWorkspace() {
    this.emit('workspace', {
      ...this.workspace
    })
  }

  emitMessages(scopeId) {
    this.emit('messages', {
      scopeId,
      messages: this.scopeMessages.get(scopeId) || []
    })
  }

  pushTranscriptEvent(name, summary, payload = null) {
    this.transcriptEvents = [
      {
        at: nowStamp(),
        name,
        summary,
        payload
      },
      ...this.transcriptEvents
    ].slice(0, MAX_EVENTS)

    this.emit('events', [...this.transcriptEvents])
  }

  async connectUserFeed() {
    if (!this.client.getState().user) {
      return
    }

    const topic = `user:${this.client.getState().user.id}`
    if (this.userTopic === topic) {
      return
    }

    await this.client.start(false)
    this.userTopic = topic
    this.pushTranscriptEvent('socket', `Joined ${topic}`)
  }

  async handleUserEvent(event, payload) {
    if (event === 'device_updated' || event === 'device_approval_requested') {
      await this.client.fetchDevices().catch(() => {})
    }

    if (event === 'server_membership_revoked') {
      await this.client.syncNow(true).catch(() => {})
    }

    this.pushTranscriptEvent(event, JSON.stringify(payload || {}).slice(0, 120), payload)
    this.emit('user-event', { event, payload })
  }

  async heartbeat() {
    if (!this.userTopic) {
      return
    }

    await this.client.start(false)
    this.pushTranscriptEvent('heartbeat', `Pushed heartbeat to ${this.userTopic}`)
  }

  async joinServerByInvite(inviteCode) {
    await this.client.joinServerByInvite(inviteCode)
    this.syncWorkspaceFromClient()
  }

  async createDirectMessage(username) {
    const users = await this.client.searchUsers(username)
    const user = users.find((entry) => entry.username === username) || users[0]
    if (!user) {
      throw new Error(`User not found: ${username}`)
    }

    await this.client.createConversation([user.id])
    this.syncWorkspaceFromClient()
  }

  async openScope(scope) {
    this.activeScope = scope
    await this.joinScope(scope)
    await this.fetchScopeMessages(scope)
  }

  async joinScope(scope) {
    const topic = scopeTopic(scope)
    if (this.joinedTopics.has(topic)) {
      return
    }

    await this.chat.watchScope(scope, async ({ event, payload, message }) => {
      if (event === 'new_message' && message) {
        this.upsertScopeMessage(scope.id, message)
        this.emitMessages(scope.id)
        return
      }

      if (event === 'message_deleted') {
        const existing = this.scopeMessages.get(scope.id) || []
        this.scopeMessages.set(
          scope.id,
          existing.filter((entry) => entry.id !== payload?.message_id)
        )

        if (scope.kind === 'channel' && Object.hasOwn(payload || {}, 'latest_message')) {
          this.applyScopeSummaryUpdate({
            kind: 'channel',
            scope_id: scope.id,
            channel_activity: {
              channel_id: scope.id,
              message_id: payload?.latest_message?.id || null,
              inserted_at: payload?.latest_message?.inserted_at || null,
              sender_id: payload?.latest_message?.sender_id || null,
              sender: payload?.latest_message?.sender || null
            }
          })
        }

        if (scope.kind === 'dm' && Object.hasOwn(payload || {}, 'latest_message')) {
          this.applyScopeSummaryUpdate({
            kind: 'dm',
            scope_id: scope.id,
            conversation_reset: {
              conversation_id: scope.id,
              last_message: payload?.latest_message || null
            }
          })
        }

        this.emitMessages(scope.id)
        return
      }

      this.pushTranscriptEvent(
        event,
        `${scope.kind}:${scope.id} ${JSON.stringify(payload || {}).slice(0, 96)}`,
        payload
      )
    })

    this.joinedTopics.add(topic)

    if (this.workspace.canUseE2EE) {
      await this.chat.ensureScopeReady(scope, false).catch(() => {})
    }
  }

  async handleScopeEvent(scope, event, payload) {
    if (event === 'new_message') {
      const processed = await this.processIncomingMessage(scope.id, payload)
      this.upsertScopeMessage(scope.id, processed)
      this.emitMessages(scope.id)
      return
    }

    if (event === 'message_deleted') {
      const existing = this.scopeMessages.get(scope.id) || []
      this.scopeMessages.set(
        scope.id,
        existing.filter((message) => message.id !== payload?.message_id)
      )

      if (scope.kind === 'channel' && Object.hasOwn(payload || {}, 'latest_message')) {
        this.applyScopeSummaryUpdate({
          kind: 'channel',
          scope_id: scope.id,
          channel_activity: {
            channel_id: scope.id,
            message_id: payload?.latest_message?.id || null,
            inserted_at: payload?.latest_message?.inserted_at || null,
            sender_id: payload?.latest_message?.sender_id || null,
            sender: payload?.latest_message?.sender || null
          }
        })
      }

      if (scope.kind === 'dm' && Object.hasOwn(payload || {}, 'latest_message')) {
        this.applyScopeSummaryUpdate({
          kind: 'dm',
          scope_id: scope.id,
          conversation_reset: {
            conversation_id: scope.id,
            last_message: payload?.latest_message || null
          }
        })
      }

      this.emitMessages(scope.id)
      return
    }

    if (event === 'mls_request_join_all' && scope.kind === 'channel' && !this.hasGroup(scope.id)) {
      this.recentJoinRequests.delete(scopeTopic(scope))
      await this.requestMlsJoin(scope)
      return
    }

    if (event === 'mls_request_join') {
      await this.handleJoinRequestEvent(scope, payload)
      return
    }

    if (event === 'mls_commit') {
      const senderId = payload?.sender_id || null
      const senderDeviceId = payload?.sender_device_id || null
      if (
        senderId !== this.workspace.user?.id ||
        senderDeviceId !== this.deviceIdentity.id
      ) {
        await this.handleCommit(scope.id, payload?.commit_data || null)
      }
      return
    }

    if (event === 'mls_welcome') {
      if (
        payload?.recipient_id === this.workspace.user?.id &&
        (!payload?.recipient_device_id ||
          payload?.recipient_device_id === this.deviceIdentity.id)
      ) {
        const processed = await this.handleWelcome(
          scope.id,
          payload?.welcome_data || null,
          payload?.key_package_ref || null
        )
        if (processed && payload?.id) {
          await ackPendingWelcome(payload.id).catch(() => {})
        }
      }
      return
    }

    this.pushTranscriptEvent(
      event,
      `${scope.kind}:${scope.id} ${JSON.stringify(payload || {}).slice(0, 96)}`,
      payload
    )
  }

  async handleJoinRequestEvent(scope, payload) {
    if (!this.hasGroup(scope.id)) {
      return
    }

    const requesterId = payload?.user_id || null
    const requesterDeviceId = payload?.device_id || null
    if (!requesterId) {
      return
    }

    const joinKey = `${scope.id}:${requesterId}:${requesterDeviceId || 'unknown'}`
    const lastHandledAt = this.recentHandledJoinRequests.get(joinKey) || 0
    if (Date.now() - lastHandledAt < RECENT_JOIN_REQUEST_TTL_MS) {
      return
    }

    this.recentHandledJoinRequests.set(joinKey, Date.now())

    const response = await this.handleJoinRequest(scope.id, requesterId, requesterDeviceId)
    if (!response) {
      return
    }

    const topic = scopeTopic(scope)
    await this.pushToChannelWithAck(topic, 'mls_commit', {
      commit_data: response.commitBytes
    })

    if (response.welcomeBytes) {
      await this.pushToChannelWithAck(topic, 'mls_welcome', {
        recipient_id: requesterId,
        recipient_device_id: requesterDeviceId,
        welcome_data: response.welcomeBytes,
        key_package_ref: response.keyPackageRef
      })
    }
  }

  async fetchScopeMessages(scope) {
    const synced = await this.chat.syncScope(scope, { limit: 50 })
    this.scopeMessages.set(scope.id, synced.messages.slice(-MAX_MESSAGES_PER_SCOPE))
    this.emitMessages(scope.id)
  }

  findScopeMessage(scopeId, messageId) {
    const messages = this.scopeMessages.get(scopeId) || []
    return messages.find((message) => message.id === messageId) || null
  }

  upsertScopeMessage(scopeId, message) {
    const existing = this.scopeMessages.get(scopeId) || []
    const filtered = existing.filter((entry) => entry.id !== message.id)
    this.scopeMessages.set(
      scopeId,
      sortMessages([...filtered, message]).slice(-MAX_MESSAGES_PER_SCOPE)
    )
  }

  async processIncomingMessage(scopeId, rawMessage) {
    let content = typeof rawMessage.content === 'string' ? rawMessage.content : ''
    let encrypted = false
    let decryptionFailed = false

    if (typeof rawMessage.ciphertext === 'string') {
      encrypted = true
      const plaintext = await this.decryptForScope(scopeId, rawMessage.ciphertext)
      if (plaintext) {
        content = coerceTextPayload(plaintext)
      } else {
        content = ENCRYPTED_UNAVAILABLE_PLACEHOLDER
        decryptionFailed = true
      }
    }

    return {
      id: rawMessage.id,
      content,
      senderId: rawMessage.sender_id || null,
      senderUsername: rawMessage.sender?.username || null,
      insertedAt: rawMessage.inserted_at,
      parentMessageId: rawMessage.parent_message_id || null,
      channelId: rawMessage.channel_id || null,
      conversationId: rawMessage.conversation_id || null,
      raw: rawMessage,
      encrypted,
      decryptionFailed
    }
  }

  async sendToScope(scope, content) {
    await this.chat.sendText(scope, content)
  }

  getServer(serverId) {
    return this.workspace.servers.find((server) => server.id === serverId) || null
  }

  getConversation(conversationId) {
    return this.workspace.conversations.find((conversation) => conversation.id === conversationId) || null
  }

  applyScopeSummaryUpdate(payload) {
    if (!payload || typeof payload !== 'object') {
      return
    }

    if (payload.kind === 'channel' && payload.channel_activity) {
      this.workspace = {
        ...this.workspace,
        servers: applyChannelActivity(this.workspace.servers, [payload.channel_activity])
      }
      this.emitWorkspace()
      return
    }

    if (payload.kind === 'dm' && payload.conversation_reset) {
      this.workspace = {
        ...this.workspace,
        conversations: applyConversationResets(this.workspace.conversations, [payload.conversation_reset])
      }
      this.emitWorkspace()
    }
  }

  applyNewConversation(payload) {
    const conversation = payload?.conversation
    if (!conversation || typeof conversation !== 'object' || !conversation.id) {
      return
    }

    this.workspace = {
      ...this.workspace,
      conversations: mergeById(this.workspace.conversations, [conversation]),
      unreadCounts: setUnreadCount(this.workspace.unreadCounts, 'dm', conversation.id, 0)
    }
    this.emitWorkspace()
  }

  applyDirectMessageSummary(payload) {
    const conversationId = payload?.conversation_id
    if (!conversationId) {
      return
    }

    const lastMessage = {
      id: payload?.message_id || null,
      conversation_id: conversationId,
      sender_id: payload?.sender_id || null,
      sender: payload?.sender || null,
      inserted_at: payload?.inserted_at || null,
      ciphertext: 'encrypted'
    }

    this.workspace = {
      ...this.workspace,
      conversations: applyConversationResets(this.workspace.conversations, [
        {
          conversation_id: conversationId,
          last_message: lastMessage.id ? lastMessage : null
        }
      ])
    }
    this.emitWorkspace()
  }

  applyChannelUnreadUpdate(payload) {
    const channelId = payload?.channel_id
    if (!channelId) {
      return
    }

    this.workspace = {
      ...this.workspace,
      servers: applyChannelActivity(this.workspace.servers, [
        {
          channel_id: channelId,
          message_id: payload?.message_id || null,
          inserted_at: payload?.inserted_at || null,
          sender_id: payload?.sender_id || null,
          sender: payload?.sender || null
        }
      ]),
      unreadCounts: incrementUnreadCount(this.workspace.unreadCounts, 'channel', channelId)
    }
    this.emitWorkspace()
  }

  incrementScopeUnread(kind, scopeId) {
    if (!scopeId) {
      return
    }

    this.workspace = {
      ...this.workspace,
      unreadCounts: incrementUnreadCount(this.workspace.unreadCounts, kind, scopeId)
    }
    this.emitWorkspace()
  }

  hasGroup(scopeId) {
    return this.groupStates.has(scopeId)
  }

  getGroupMemberCount(scopeId) {
    const state = this.groupStates.get(scopeId)
    return state ? getGroupLeafIdentities(state).length : 0
  }

  async setGroupState(scopeId, state) {
    this.groupStates.set(scopeId, state)
    await saveGroupState(scopeId, serializeGroupState(state), Number(state.groupContext.epoch))
  }

  async ensureGroupMembership(scopeId) {
    if (this.hasGroup(scopeId)) {
      await this.processPendingCommits(scopeId)
      return true
    }

    const persisted = await loadGroupState(scopeId)
    if (persisted) {
      try {
        const state = deserializeGroupState(new Uint8Array(persisted.state))
        this.groupStates.set(scopeId, state)
        await this.processPendingCommits(scopeId)
        return true
      } catch {
        this.groupStates.delete(scopeId)
      }
    }

    const welcomes = await fetchPendingWelcomes(scopeId)
    for (const welcome of welcomes) {
      const processed = await this.handleWelcome(
        scopeId,
        uint8ToBase64(welcome.welcome_data),
        welcome.key_package_ref
      )

      if (processed) {
        await ackPendingWelcome(welcome.id).catch(() => {})
        return true
      }
    }

    return false
  }

  async loadOrderedWelcomeKeyPackages(keyPackageRef) {
    const localPackages = await loadKeyPackages()
    if (!keyPackageRef || localPackages.length === 0) {
      return localPackages
    }

    const matching = []
    const remaining = []

    for (const localPackage of localPackages) {
      const encoded = uint8ToBase64(new Uint8Array(localPackage.publicData))
      if (encoded === keyPackageRef) {
        matching.push(localPackage)
      } else {
        remaining.push(localPackage)
      }
    }

    return [...matching, ...remaining]
  }

  async createGroup(scopeId) {
    if (this.hasGroup(scopeId)) {
      return
    }

    await initCipherSuite()
    await this.client.replenishKeyPackages()

    const localPackages = await loadKeyPackages()
    let publicPackage = null
    let privatePackage = null

    if (localPackages.length > 0) {
      const localPackage = localPackages[0]
      await consumeKeyPackage(localPackage.id)
      publicPackage = decodeKeyPackageBytes(new Uint8Array(localPackage.publicData))
      privatePackage = deserializePrivatePackage(new Uint8Array(localPackage.privateData))
    } else {
      const pairs = await createKeyPackageBatch(
        buildClientCredentialIdentity(this.workspace.user.id, this.deviceIdentity.id),
        1
      )
      publicPackage = pairs[0].publicPackage
      privatePackage = pairs[0].privatePackage
    }

    const state = await createMLSGroup(scopeId, publicPackage, privatePackage)
    await this.setGroupState(scopeId, state)
    await this.client.replenishKeyPackages()
  }

  async handleJoinRequest(scopeId, userId, deviceId) {
    if (!this.hasGroup(scopeId)) {
      return null
    }

    await initCipherSuite()
    const keyPackageBytes = await fetchKeyPackage(userId, deviceId || undefined)
    if (!keyPackageBytes) {
      return null
    }

    const state = this.groupStates.get(scopeId)
    const memberKeyPackage = decodeKeyPackageBytes(keyPackageBytes)
    const requestedCredential = memberKeyPackage.leafNode.credential
    const requestedIdentity =
      requestedCredential.credentialType === 'basic'
        ? new TextDecoder().decode(requestedCredential.identity)
        : null

    if (
      requestedIdentity &&
      (getGroupLeafIdentities(state).includes(requestedIdentity) ||
        groupHasMember(state, requestedIdentity))
    ) {
      return null
    }

    const result = await addMemberToGroup(state, memberKeyPackage)
    await this.setGroupState(scopeId, result.newState)

    return {
      commitBytes: uint8ToBase64(result.commitBytes),
      welcomeBytes: result.welcomeBytes ? uint8ToBase64(result.welcomeBytes) : null,
      keyPackageRef: uint8ToBase64(keyPackageBytes)
    }
  }

  async handleWelcome(scopeId, welcomeData, keyPackageRef) {
    if (!welcomeData) {
      return false
    }

    await initCipherSuite()
    const orderedPackages = await this.loadOrderedWelcomeKeyPackages(keyPackageRef)
    if (orderedPackages.length === 0) {
      return false
    }

    for (const localPackage of orderedPackages) {
      try {
        const publicPackage = decodeKeyPackageBytes(new Uint8Array(localPackage.publicData))
        const privatePackage = deserializePrivatePackage(new Uint8Array(localPackage.privateData))
        const state = await processWelcome(
          Buffer.from(welcomeData, 'base64'),
          publicPackage,
          privatePackage
        )

        await this.setGroupState(scopeId, state)
        await consumeKeyPackage(localPackage.id)
        await this.processPendingCommits(scopeId)
        await this.client.replenishKeyPackages()
        return true
      } catch {
        continue
      }
    }

    return false
  }

  async handleCommit(scopeId, commitData) {
    if (!commitData) {
      return false
    }

    const currentState = this.groupStates.get(scopeId)
    if (!currentState) {
      const pending = this.pendingCommits.get(scopeId) || []
      pending.push(commitData)
      this.pendingCommits.set(scopeId, pending)
      return false
    }

    try {
      await initCipherSuite()
      const newState = await processCommitMessage(
        currentState,
        Buffer.from(commitData, 'base64')
      )
      await this.setGroupState(scopeId, newState)
      return true
    } catch {
      return false
    }
  }

  async processPendingCommits(scopeId) {
    if (!this.hasGroup(scopeId)) {
      return
    }

    const pending = this.pendingCommits.get(scopeId) || []
    this.pendingCommits.set(scopeId, [])

    for (const commitData of pending) {
      await this.handleCommit(scopeId, commitData)
    }
  }

  async encryptForScope(scopeId, plaintext) {
    const state = this.groupStates.get(scopeId)
    if (!state) {
      throw new Error(`No MLS state for ${scopeId}`)
    }

    const encrypted = await encryptMessage(state, plaintext)
    await this.setGroupState(scopeId, encrypted.newState)

    return {
      ciphertext: uint8ToBase64(encrypted.ciphertext),
      epoch: encrypted.epoch
    }
  }

  async decryptForScope(scopeId, ciphertext) {
    const state = this.groupStates.get(scopeId)
    if (!state) {
      return null
    }

    const decrypted = await decryptMessage(state, Buffer.from(ciphertext, 'base64'))
    if (!decrypted) {
      return null
    }

    await this.setGroupState(scopeId, decrypted.newState)
    return decrypted.plaintext
  }

  async requestMlsJoin(scope) {
    const topic = scopeTopic(scope)
    const now = Date.now()
    const lastRequestAt = this.recentJoinRequests.get(topic) || 0
    if (now - lastRequestAt < 1_500) {
      return
    }

    this.recentJoinRequests.set(topic, now)
    await this.client.replenishKeyPackages()

    await this.pushToChannelWithAck(topic, 'mls_request_join', {
      device_id: this.deviceIdentity.id
    })
  }

  async waitForChannelBootstrap(channelId, initialMemberCount) {
    const deadline = Date.now() + JOIN_WAIT_MS
    let lastCount = this.getGroupMemberCount(channelId)
    let lastChangeTime = Date.now()

    while (Date.now() < deadline) {
      if (!this.hasGroup(channelId)) {
        return false
      }

      const currentCount = this.getGroupMemberCount(channelId)
      if (currentCount !== lastCount) {
        lastCount = currentCount
        lastChangeTime = Date.now()
      }

      const stableForMs = Date.now() - lastChangeTime
      if (currentCount > initialMemberCount && stableForMs >= 250) {
        return true
      }

      if (currentCount <= 1 && initialMemberCount <= 1 && stableForMs >= 250) {
        return true
      }

      await this.ensureGroupMembership(channelId).catch(() => false)
      await sleep(100)
    }

    return this.hasGroup(channelId)
  }

  async ensureChannelGroupReady(channelId, allowCreate = false) {
    if (await this.ensureGroupMembership(channelId)) {
      return true
    }

    const scope = { kind: 'channel', id: channelId }
    await this.requestMlsJoin(scope)

    const deadline = Date.now() + JOIN_WAIT_MS
    while (Date.now() < deadline) {
      if (await this.ensureGroupMembership(channelId)) {
        return true
      }

      await sleep(100)
    }

    if (!allowCreate) {
      return this.hasGroup(channelId)
    }

    const hasActivity = await this.channelHasExistingActivity(channelId)
    if (hasActivity) {
      return false
    }

    await this.createGroup(channelId)
    if (!this.hasGroup(channelId)) {
      return false
    }

    const initialMemberCount = this.getGroupMemberCount(channelId)
    await this.pushToChannelWithAck(scopeTopic(scope), 'mls_request_join_all', {})
    return await this.waitForChannelBootstrap(channelId, initialMemberCount)
  }

  async channelHasExistingActivity(channelId) {
    for (const server of this.workspace.servers) {
      const channel = server.channels.find((entry) => entry.id === channelId)
      if (channel?.last_message_id) {
        return true
      }
    }

    await this.refreshWorkspace().catch(() => {})

    for (const server of this.workspace.servers) {
      const channel = server.channels.find((entry) => entry.id === channelId)
      if (channel?.last_message_id) {
        return true
      }
    }

    return false
  }

  isDmBootstrapLeader(conversationId) {
    const conversation = this.getConversation(conversationId)
    if (!conversation || !this.workspace.user) {
      return false
    }

    const participantIds = conversation.participants
      .map((participant) => participant.user_id)
      .sort((left, right) => left.localeCompare(right))

    return participantIds[0] === this.workspace.user.id
  }

  async bootstrapDmGroupIfLeader(conversationId) {
    const conversation = this.getConversation(conversationId)
    if (!conversation || !this.workspace.user || !this.isDmBootstrapLeader(conversationId)) {
      return false
    }

    await this.createGroup(conversationId)
    if (!this.hasGroup(conversationId)) {
      return false
    }

    const topic = scopeTopic({ kind: 'dm', id: conversationId })

    for (const participant of conversation.participants) {
      if (participant.user_id === this.workspace.user.id) {
        continue
      }

      const response = await this.handleJoinRequest(
        conversationId,
        participant.user_id,
        null
      )

      if (!response) {
        continue
      }

      await this.pushToChannelWithAck(topic, 'mls_commit', {
        commit_data: response.commitBytes
      })

      if (response.welcomeBytes) {
        await this.pushToChannelWithAck(topic, 'mls_welcome', {
          recipient_id: participant.user_id,
          welcome_data: response.welcomeBytes,
          key_package_ref: response.keyPackageRef
        })
      }
    }

    return this.hasGroup(conversationId)
  }

  async ensureDmGroupReady(conversationId, allowForce = false) {
    if (await this.ensureGroupMembership(conversationId)) {
      return true
    }

    if (await this.bootstrapDmGroupIfLeader(conversationId)) {
      return true
    }

    await this.requestMlsJoin({ kind: 'dm', id: conversationId })

    const deadline = Date.now() + JOIN_WAIT_MS
    while (Date.now() < deadline) {
      if (await this.ensureGroupMembership(conversationId)) {
        return true
      }

      await sleep(100)
    }

    if (!allowForce) {
      return this.hasGroup(conversationId)
    }

    await this.createGroup(conversationId)
    return this.hasGroup(conversationId)
  }

  async pushToChannelWithAck(topic, event, payload) {
    const scopeKind = topic.startsWith('chat:channel:')
      ? 'channel'
      : topic.startsWith('dm:')
        ? 'dm'
        : null
    const scopeId =
      scopeKind === 'channel'
        ? topic.slice('chat:channel:'.length)
        : scopeKind === 'dm'
          ? topic.slice('dm:'.length)
          : null

    if (!scopeKind || !scopeId) {
      return false
    }

    return await this.client.pushScopeEvent(scopeKind, scopeId, event, payload)
  }

  shutdown() {
    this.client.stop()
  }
}

export function formatScopeLabel(runtime, scope) {
  if (!scope) {
    return 'No chat selected'
  }

  if (scope.kind === 'channel') {
    for (const server of runtime.servers) {
      const channel = server.channels.find((entry) => entry.id === scope.id)
      if (channel) {
        return `${server.name} / #${channel.name}`
      }
    }

    return `#${shortId(scope.id)}`
  }

  const conversation = runtime.getConversation(scope.id)
  if (!conversation) {
    return `dm:${shortId(scope.id)}`
  }

  const others = conversation.participants
    .filter((participant) => participant.user_id !== runtime.user?.id)
    .map((participant) => participant.user.username)

  return others.length > 0 ? `@${others.join(', ')}` : 'Direct message'
}
