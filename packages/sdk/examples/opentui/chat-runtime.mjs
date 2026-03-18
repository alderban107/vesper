import { EventEmitter } from 'node:events'

import {
  ackPendingWelcome,
  apiFetch,
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
  createConversation,
  createSdkHarness,
  getCurrentUser,
  listConversations,
  listServers,
  searchUsers
} from '../_shared.mjs'

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

export class VesperChatRuntime extends EventEmitter {
  constructor(options = {}) {
    super()

    this.deviceLabel = options.deviceLabel || 'opentui-chat'
    this.deviceId = options.deviceId || process.env.VESPER_DEVICE_ID?.trim() || null
    this.deviceName =
      options.deviceName || process.env.VESPER_DEVICE_NAME?.trim() || 'SDK Sample OpenTUI Chat'

    this.harness = createSdkHarness(this.deviceLabel, {
      deviceId: this.deviceId,
      deviceName: this.deviceName
    })

    this.session = null
    this.workspace = {
      user: null,
      currentDevice: null,
      devices: [],
      servers: [],
      conversations: [],
      canUseE2EE: false
    }

    this.scopeMessages = new Map()
    this.joinedTopics = new Set()
    this.userTopic = null
    this.activeScope = null
    this.groupStates = new Map()
    this.pendingCommits = new Map()
    this.recentJoinRequests = new Map()
    this.recentHandledJoinRequests = new Map()
    this.transcriptEvents = []
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

  async register(username, password) {
    this.session = await this.harness.auth.register(username, password)
    await this.finishAuth()
    return this.session
  }

  async restoreSession() {
    this.session = await this.harness.auth.checkAuth()
    if (!this.session) {
      return null
    }

    await this.finishAuth()
    return this.session
  }

  async login(username, password) {
    this.session = await this.harness.auth.login(username, password)
    await this.finishAuth()
    return this.session
  }

  async recoverAccount(mnemonic, newPassword) {
    this.session = await this.harness.auth.recoverAccount(mnemonic, newPassword)
    await this.finishAuth()
    return this.session
  }

  async approveCurrentDeviceWithRecovery(mnemonic) {
    this.session = await this.harness.auth.approveCurrentDeviceWithRecovery(mnemonic)
    await this.finishAuth()
    return this.session
  }

  async unlockTrustedDevice(password) {
    if (!this.workspace.user) {
      throw new Error('No active session to unlock')
    }

    this.session = await this.harness.auth.unlockTrustedDevice(
      this.workspace.user,
      this.workspace.currentDevice,
      password
    )
    await this.finishAuth()
    return this.session
  }

  async logout() {
    await this.harness.auth.logout().catch(() => {})
    this.harness.socket.disconnect()
    this.session = null
    this.workspace = {
      user: null,
      currentDevice: null,
      devices: [],
      servers: [],
      conversations: [],
      canUseE2EE: false
    }
    this.scopeMessages.clear()
    this.joinedTopics.clear()
    this.activeScope = null
    this.userTopic = null
    this.groupStates.clear()
    this.pendingCommits.clear()
    this.emitWorkspace()
  }

  async finishAuth() {
    await this.refreshWorkspace()
    await this.harness.auth.replenishKeyPackages(
      this.workspace.user,
      this.workspace.canUseE2EE
    )
    await this.connectUserFeed()
  }

  async refreshWorkspace() {
    if (!this.session) {
      return
    }

    const [user, servers, conversations, deviceState] = await Promise.all([
      getCurrentUser(),
      listServers(),
      listConversations(),
      this.harness.auth.fetchDevices({
        devices: this.workspace.devices.length > 0 ? this.workspace.devices : this.session.devices,
        currentDevice: this.workspace.currentDevice || this.session.currentDevice,
        user: this.workspace.user || this.session.user
      })
    ])

    this.workspace = {
      user,
      currentDevice: deviceState.currentDevice,
      devices: deviceState.devices,
      servers,
      conversations,
      canUseE2EE: deviceState.canUseE2EE
    }

    this.emitWorkspace()
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
    if (!this.workspace.user) {
      return
    }

    const topic = `user:${this.workspace.user.id}`
    if (this.userTopic === topic) {
      return
    }

    this.harness.socket.connect()
    await this.harness.socket.joinChannelWithAck(topic, async (event, payload) => {
      await this.handleUserEvent(event, payload)
    })

    this.harness.socket.pushToChannel(topic, 'heartbeat', {})
    this.userTopic = topic
    this.pushTranscriptEvent('socket', `Joined ${topic}`)
  }

  async handleUserEvent(event, payload) {
    if (event === 'new_conversation' || event === 'device_updated') {
      await this.refreshWorkspace().catch(() => {})
    }

    if (event === 'device_approval_requested') {
      await this.refreshWorkspace().catch(() => {})
    }

    this.pushTranscriptEvent(event, JSON.stringify(payload || {}).slice(0, 120), payload)
    this.emit('user-event', { event, payload })
  }

  async heartbeat() {
    if (!this.userTopic) {
      return
    }

    this.harness.socket.pushToChannel(this.userTopic, 'heartbeat', {})
    this.pushTranscriptEvent('heartbeat', `Pushed heartbeat to ${this.userTopic}`)
  }

  async joinServerByInvite(inviteCode) {
    const response = await apiFetch('/api/v1/servers/join', {
      method: 'POST',
      body: JSON.stringify({ invite_code: inviteCode })
    })

    if (!response.ok) {
      throw new Error('Could not join server')
    }

    await this.refreshWorkspace()
  }

  async createDirectMessage(username) {
    const users = await searchUsers(username)
    const user = users.find((entry) => entry.username === username) || users[0]
    if (!user) {
      throw new Error(`User not found: ${username}`)
    }

    await createConversation([user.id])
    await this.refreshWorkspace()
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

    this.harness.socket.connect()
    await this.harness.socket.joinChannelWithAck(topic, async (event, payload) => {
      await this.handleScopeEvent(scope, event, payload)
    })

    this.joinedTopics.add(topic)

    if (this.workspace.canUseE2EE) {
      if (scope.kind === 'channel') {
        await this.ensureChannelGroupReady(scope.id, false).catch(() => {})
      } else {
        await this.ensureDmGroupReady(scope.id).catch(() => {})
      }
    }
  }

  async handleScopeEvent(scope, event, payload) {
    if (event === 'new_message') {
      const processed = await this.processIncomingMessage(scope.id, payload)
      this.upsertScopeMessage(scope.id, processed)
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
        senderDeviceId !== this.harness.deviceIdentity.id
      ) {
        await this.handleCommit(scope.id, payload?.commit_data || null)
      }
      return
    }

    if (event === 'mls_welcome') {
      if (
        payload?.recipient_id === this.workspace.user?.id &&
        (!payload?.recipient_device_id ||
          payload?.recipient_device_id === this.harness.deviceIdentity.id)
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
    const endpoint =
      scope.kind === 'channel'
        ? `/api/v1/channels/${scope.id}/messages?limit=50`
        : `/api/v1/conversations/${scope.id}/messages?limit=50`

    if (this.workspace.canUseE2EE) {
      if (scope.kind === 'channel') {
        await this.ensureChannelGroupReady(scope.id, false).catch(() => {})
      } else {
        await this.ensureDmGroupReady(scope.id).catch(() => {})
      }
    }

    const response = await apiFetch(endpoint)
    if (!response.ok) {
      throw new Error(`Could not load messages for ${scope.kind}:${scope.id}`)
    }

    const data = await response.json()
    const rawMessages = Array.isArray(data.messages) ? sortRawMessages(data.messages) : []
    const processed = []

    for (const rawMessage of rawMessages) {
      const cached = this.findScopeMessage(scope.id, rawMessage.id)
      if (cached) {
        processed.push(cached)
        continue
      }

      processed.push(await this.processIncomingMessage(scope.id, rawMessage))
    }

    this.scopeMessages.set(scope.id, sortMessages(processed).slice(-MAX_MESSAGES_PER_SCOPE))
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
    if (!this.workspace.canUseE2EE) {
      throw new Error('Encrypted chat is not ready on this device yet')
    }

    await this.joinScope(scope)

    if (scope.kind === 'channel') {
      const ready = await this.ensureChannelGroupReady(scope.id, true)
      if (!ready) {
        throw new Error('Channel group is still syncing')
      }
    } else {
      const ready = await this.ensureDmGroupReady(scope.id, true)
      if (!ready) {
        throw new Error('Conversation group is still syncing')
      }
    }

    const encrypted = await this.encryptForScope(
      scope.id,
      encodePayload({ v: 1, type: 'text', text: content })
    )
    const pushed = await this.pushToChannelWithAck(scopeTopic(scope), 'new_message', {
      ciphertext: encrypted.ciphertext,
      mls_epoch: encrypted.epoch
    })

    if (!pushed) {
      throw new Error('Message send failed')
    }

    await this.fetchScopeMessages(scope).catch(() => {})
  }

  getServer(serverId) {
    return this.workspace.servers.find((server) => server.id === serverId) || null
  }

  getConversation(conversationId) {
    return this.workspace.conversations.find((conversation) => conversation.id === conversationId) || null
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
    await this.harness.auth.replenishKeyPackages(this.workspace.user, true)

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
        buildClientCredentialIdentity(this.workspace.user.id, this.harness.deviceIdentity.id),
        1
      )
      publicPackage = pairs[0].publicPackage
      privatePackage = pairs[0].privatePackage
    }

    const state = await createMLSGroup(scopeId, publicPackage, privatePackage)
    await this.setGroupState(scopeId, state)
    await this.harness.auth.replenishKeyPackages(this.workspace.user, true)
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
        await this.harness.auth.replenishKeyPackages(this.workspace.user, true)
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
    await this.harness.auth.replenishKeyPackages(this.workspace.user, true)

    await this.pushToChannelWithAck(topic, 'mls_request_join', {
      device_id: this.harness.deviceIdentity.id
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

    const response = await apiFetch(`/api/v1/channels/${channelId}/messages?limit=1`)
    if (!response.ok) {
      return false
    }

    const data = await response.json()
    return Array.isArray(data.messages) && data.messages.length > 0
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
    const channel = this.harness.socket.getChannel(topic)
    if (!channel) {
      return false
    }

    return await new Promise((resolve) => {
      channel
        .push(event, payload)
        .receive('ok', () => resolve(true))
        .receive('error', () => resolve(false))
        .receive('timeout', () => resolve(false))
    })
  }

  shutdown() {
    this.harness.socket.disconnect()
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
