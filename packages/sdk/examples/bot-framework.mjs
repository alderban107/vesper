import { homedir } from 'node:os'
import path from 'node:path'

import {
  ackPendingWelcome,
  fetchKeyPackage,
  fetchPendingWelcomes,
  uint8ToBase64
} from '../dist/api/index.js'
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
  getGroupLeafIdentities,
  groupHasMember,
  initCipherSuite,
  processCommitMessage,
  processWelcome,
  serializeGroupState
} from '../dist/crypto/index.js'
import {
  consumeKeyPackage,
  loadGroupState,
  loadKeyPackages,
  saveGroupState
} from '../dist/storage/index.js'
import {
  VesperStorage,
  createFileSessionStore,
  createVesperClient
} from '../dist/index.js'
import {
  createSampleDeviceIdentity,
  registerOrLogin,
  requiredEnv
} from './_shared.mjs'

const MLS_JOIN_WAIT_MS = 2_500
const CHANNEL_HISTORY_LIMIT = 20
const MAX_HANDLED_MESSAGE_IDS = 256
const JOIN_REQUEST_COOLDOWN_MS = 1_500
const MENTION_PATTERN = /<@([0-9a-f-]{36})>/g

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
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

function extractMentionedUserIds(content) {
  const ids = []
  let match = null

  MENTION_PATTERN.lastIndex = 0
  while ((match = MENTION_PATTERN.exec(content)) !== null) {
    ids.push(match[1])
  }

  if (content.includes('<@everyone>')) {
    ids.push('everyone')
  }

  return [...new Set(ids)]
}

function splitCommand(text) {
  const trimmed = text.trim()
  if (!trimmed) {
    return {
      name: 'help',
      args: [],
      text: ''
    }
  }

  const [name, ...args] = trimmed.split(/\s+/)
  return {
    name: name.toLowerCase(),
    args,
    text: args.join(' ')
  }
}

export class VesperBot {
  constructor(options = {}) {
    this.deviceLabel = options.deviceLabel || 'bot'
    this.deviceId = options.deviceId || null
    this.deviceName = options.deviceName || null
    this.username = options.username || requiredEnv('VESPER_USERNAME')
    this.password = options.password || requiredEnv('VESPER_PASSWORD')
    this.commandPrefix = options.commandPrefix || '!'
    this.historyLimit = options.historyLimit || CHANNEL_HISTORY_LIMIT
    this.handlers = new Map()
    this.commandHandlers = new Map()
    this.groupStates = new Map()
    this.pendingCommits = new Map()
    this.joinedChannels = new Set()
    this.recentJoinRequests = new Map()
    this.handledMessageIds = []
    this.client = null
    this.chat = null
    this.deviceIdentityValue =
      options.deviceIdentity || createSampleDeviceIdentity(this.deviceLabel, options)
    this.session = null
    this.heartbeat = null
  }

  on(event, handler) {
    const handlers = this.handlers.get(event) || []
    handlers.push(handler)
    this.handlers.set(event, handlers)
    return this
  }

  command(name, handler) {
    this.commandHandlers.set(name.toLowerCase(), handler)
    return this
  }

  get user() {
    return this.session?.user ?? null
  }

  get auth() {
    return this.client
  }

  get deviceIdentity() {
    return this.client?.deviceIdentity ?? this.deviceIdentityValue
  }

  async start() {
    const apiUrl = requiredEnv('VESPER_API_URL')
    const baseDir = resolveSampleStateDir(this.deviceLabel)
    this.client = createVesperClient({
      baseUrl: apiUrl,
      sessionStore: createFileSessionStore(path.join(baseDir, 'session.json'), apiUrl),
      storage: (userId) =>
        new VesperStorage.FileCryptoStorage(path.join(baseDir, 'crypto', `${userId}.json`)),
      auth: {
        getDeviceIdentity: () => this.deviceIdentityValue
      }
    })
    this.session =
      (await this.client.restoreSession()) ??
      (await registerOrLogin(this.client, this.username, this.password))
    this.chat = this.client.createEncryptedChat()
    await this.client.start(false)

    if (!this.session.canUseE2EE) {
      const trustState = this.session.currentDevice?.trust_state ?? 'unknown'
      throw new Error(
        `This sample needs an approved encrypted device. Current device state: ${trustState}.`
      )
    }

    await this.client.replenishKeyPackages()

    this.client.on('raw', ({ event, payload }) => {
      void (async () => {
        if (event === 'mention') {
          await this.handleMentionEvent(payload)
        }

        await this.emit(event, {
          bot: this,
          event,
          payload
        })
      })()
    })
    return this
  }

  async stop() {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }

    this.joinedChannels.clear()
    this.groupStates.clear()
    this.pendingCommits.clear()
    this.chat?.reset()

    if (this.client) {
      this.client.stop()
    }
  }

  async reply(channelId, text, options = {}) {
    return await this.sendChannelText(channelId, text, options)
  }

  async sendChannelText(channelId, text, options = {}) {
    const parentMessageId = options.parentMessageId || undefined
    const mentionUserId = options.mentionUserId || null
    const finalText = mentionUserId ? `<@${mentionUserId}> ${text}` : text
    const mentionedUserIds = extractMentionedUserIds(finalText)
    await this.chat.sendText(
      { kind: 'channel', id: channelId },
      finalText,
      {
        parentMessageId,
        mentionedUserIds
      }
    )
  }

  async watchChannel(channelId) {
    if (this.joinedChannels.has(channelId)) {
      return
    }

    await this.chat.watchScope({ kind: 'channel', id: channelId }, async ({ event, message }) => {
      if (event !== 'new_message' || !message) {
        return
      }

      await this.dispatchChannelMessage(
        {
          id: message.id,
          channelId,
          senderId: message.senderId,
          senderUsername: message.senderUsername,
          parentMessageId: message.parentMessageId,
          insertedAt: message.insertedAt,
          text: message.content,
          raw: message.raw
        },
        'channel'
      )
    })

    this.joinedChannels.add(channelId)
    await this.chat.ensureScopeReady({ kind: 'channel', id: channelId }, false).catch(() => {})
  }

  async handleMentionEvent(payload) {
    const channelId = payload?.channel_id
    const senderId = payload?.sender_id || null

    if (!channelId) {
      return
    }

    await this.watchChannel(channelId)

    const recentMessage = await this.findRecentMentionedMessage(channelId, senderId)
    if (!recentMessage) {
      return
    }

    await this.dispatchChannelMessage(recentMessage, 'mention')
  }

  async handleChannelEvent(channelId, event, payload) {
    if (event === 'new_message') {
      const message = await this.resolveChannelMessage(channelId, payload)
      if (message) {
        await this.dispatchChannelMessage(message, 'channel')
      }
      return
    }

    if (event === 'mls_request_join_all') {
      if (!this.hasGroup(channelId)) {
        this.recentJoinRequests.delete(this.getChannelTopic(channelId))
        await this.requestMlsJoin(channelId)
      }
      return
    }

    if (event === 'mls_request_join') {
      await this.handleJoinRequestEvent(channelId, payload)
      return
    }

    if (event === 'mls_commit') {
      const senderId = payload?.sender_id || null
      const senderDeviceId = payload?.sender_device_id || null

      if (
        senderId !== this.user?.id ||
        senderDeviceId !== this.deviceIdentity?.id
      ) {
        await this.handleCommit(channelId, payload?.commit_data || null)
      }
      return
    }

    if (event === 'mls_welcome') {
      const recipientId = payload?.recipient_id || null
      const recipientDeviceId = payload?.recipient_device_id || null
      const welcomeId = payload?.id || null

      if (
        recipientId === this.user?.id &&
        (!recipientDeviceId || recipientDeviceId === this.deviceIdentity?.id)
      ) {
        const processed = await this.handleWelcome(
          channelId,
          payload?.welcome_data || null,
          payload?.key_package_ref || null
        )

        if (processed && welcomeId) {
          await ackPendingWelcome(welcomeId).catch(() => {})
        }
      }
      return
    }
  }

  async handleJoinRequestEvent(channelId, payload) {
    if (!this.hasGroup(channelId)) {
      return
    }

    const requesterId = payload?.user_id || null
    const requesterDeviceId = payload?.device_id || null

    if (!requesterId) {
      return
    }

    if (
      requesterId === this.user?.id &&
      requesterDeviceId === this.deviceIdentity?.id
    ) {
      return
    }

    const response = await this.handleJoinRequest(
      channelId,
      requesterId,
      requesterDeviceId
    )

    if (!response) {
      return
    }

    const topic = this.getChannelTopic(channelId)

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

  async dispatchChannelMessage(message, source) {
    if (message.senderId === this.user?.id) {
      return
    }

    if (this.seenMessage(message.id)) {
      return
    }

    this.rememberMessage(message.id)

    const context = {
      bot: this,
      event: 'message',
      source,
      message
    }

    await this.emit('message', context)

    const command = this.parseCommand(message.text)
    if (!command) {
      return
    }

    const commandContext = {
      ...context,
      command
    }

    await this.emit('command', commandContext)

    const namedHandler = this.commandHandlers.get(command.name)
    if (namedHandler) {
      await namedHandler(commandContext)
      return
    }

    await this.emit('unknown-command', commandContext)
  }

  parseCommand(text) {
    const botMention = `<@${this.user?.id}>`
    const trimmed = text.trim()

    if (!trimmed) {
      return null
    }

    if (trimmed.includes(botMention)) {
      const body = trimmed.replaceAll(botMention, '').trim()
      return {
        ...splitCommand(body),
        invokedByMention: true
      }
    }

    if (trimmed.startsWith(this.commandPrefix)) {
      return {
        ...splitCommand(trimmed.slice(this.commandPrefix.length)),
        invokedByMention: false
      }
    }

    return null
  }

  async findRecentMentionedMessage(channelId, senderId) {
    const ready = await this.chat.ensureScopeReady({ kind: 'channel', id: channelId }, false)
    if (!ready) {
      return null
    }

    const { messages } = await this.chat.syncScope(
      { kind: 'channel', id: channelId },
      { limit: this.historyLimit }
    )
    for (const message of messages) {
      if (senderId && message.senderId !== senderId) {
        continue
      }

      if (
        message.content.includes(`<@${this.user.id}>`) ||
        message.content.includes('<@everyone>')
      ) {
        return {
          id: message.id,
          channelId,
          senderId: message.senderId,
          senderUsername: message.senderUsername,
          parentMessageId: message.parentMessageId,
          insertedAt: message.insertedAt,
          text: message.content,
          raw: message.raw
        }
      }
    }

    return null
  }

  async resolveChannelMessage(channelId, rawMessage) {
    if (!rawMessage?.id || !rawMessage?.sender_id) {
      return null
    }

    let text = typeof rawMessage.content === 'string' ? rawMessage.content : ''

    if (typeof rawMessage.ciphertext === 'string') {
      const decrypted = await this.decryptForChannel(channelId, rawMessage.ciphertext)
      if (!decrypted) {
        return null
      }

      const payload = decodePayload(decrypted)
      text = payload.type === 'text' ? payload.text : (payload.text || '')
    }

    return {
      id: rawMessage.id,
      channelId,
      senderId: rawMessage.sender_id,
      senderUsername: rawMessage.sender?.username || null,
      parentMessageId: rawMessage.parent_message_id || null,
      insertedAt: rawMessage.inserted_at || null,
      text,
      raw: rawMessage
    }
  }

  async fetchChannelMessages(channelId, limit = CHANNEL_HISTORY_LIMIT) {
    return await this.client.fetchChannelMessages(channelId, limit)
  }

  async ensureChannelGroupReady(channelId, allowCreate = false) {
    if (this.hasGroup(channelId)) {
      return true
    }

    const processedWelcome = await this.ensureGroupMembership(channelId)
    if (processedWelcome || this.hasGroup(channelId)) {
      return true
    }

    await this.requestMlsJoin(channelId)

    const deadline = Date.now() + MLS_JOIN_WAIT_MS
    while (Date.now() < deadline) {
      if (this.hasGroup(channelId)) {
        return true
      }

      await this.ensureGroupMembership(channelId)
      if (this.hasGroup(channelId)) {
        return true
      }

      await sleep(100)
    }

    if (!allowCreate) {
      return false
    }

    const messages = await this.fetchChannelMessages(channelId, 1).catch(() => [])
    if (messages.length > 0) {
      return false
    }

    await this.createGroup(channelId)
    if (!this.hasGroup(channelId)) {
      return false
    }

    await this.pushToChannelWithAck(
      this.getChannelTopic(channelId),
      'mls_request_join_all',
      {}
    )

    return true
  }

  async ensureGroupMembership(channelId) {
    if (this.hasGroup(channelId)) {
      await this.processPendingCommits(channelId)
      return false
    }

    const persisted = await loadGroupState(channelId)
    if (persisted) {
      try {
        const state = deserializeGroupState(new Uint8Array(persisted.state))
        this.groupStates.set(channelId, state)
        await this.processPendingCommits(channelId)
        return false
      } catch {
        this.groupStates.delete(channelId)
      }
    }

    const welcomes = await fetchPendingWelcomes(channelId)
    for (const welcome of welcomes) {
      const processed = await this.handleWelcome(
        channelId,
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

  async requestMlsJoin(channelId) {
    const topic = this.getChannelTopic(channelId)
    const now = Date.now()
    const lastRequestAt = this.recentJoinRequests.get(topic) || 0

    if (now - lastRequestAt < JOIN_REQUEST_COOLDOWN_MS) {
      return
    }

    this.recentJoinRequests.set(topic, now)
    await this.client.replenishKeyPackages()

    await this.pushToChannelWithAck(topic, 'mls_request_join', {
      device_id: this.deviceIdentity.id
    })
  }

  async createGroup(channelId) {
    if (this.hasGroup(channelId)) {
      return
    }

    await initCipherSuite()
    await this.client.replenishKeyPackages()

    const localPackages = await loadKeyPackages()
    let publicPackage = null
    let privatePackage = null

    if (localPackages.length > 0) {
      const pkg = localPackages[0]
      await consumeKeyPackage(pkg.id)
      publicPackage = decodeKeyPackageBytes(new Uint8Array(pkg.publicData))
      privatePackage = deserializePrivatePackage(new Uint8Array(pkg.privateData))
    } else {
      const pairs = await createKeyPackageBatch(
        buildClientCredentialIdentity(this.user.id, this.deviceIdentity.id),
        1
      )
      publicPackage = pairs[0].publicPackage
      privatePackage = pairs[0].privatePackage
    }

    const state = await createMLSGroup(channelId, publicPackage, privatePackage)
    await this.setGroupState(channelId, state)
    await this.client.replenishKeyPackages()
  }

  async handleJoinRequest(channelId, userId, deviceId) {
    if (!this.hasGroup(channelId)) {
      return null
    }

    await initCipherSuite()

    const keyPackageBytes = await fetchKeyPackage(userId, deviceId || undefined)
    if (!keyPackageBytes) {
      return null
    }

    const state = this.groupStates.get(channelId)
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
    await this.setGroupState(channelId, result.newState)

    return {
      commitBytes: uint8ToBase64(result.commitBytes),
      welcomeBytes: result.welcomeBytes ? uint8ToBase64(result.welcomeBytes) : null,
      keyPackageRef: uint8ToBase64(keyPackageBytes)
    }
  }

  async handleWelcome(channelId, welcomeData, keyPackageRef) {
    if (!welcomeData) {
      return false
    }

    await initCipherSuite()

    const orderedPackages = await this.loadOrderedWelcomeKeyPackages(keyPackageRef)
    if (orderedPackages.length === 0) {
      return false
    }

    for (const pkg of orderedPackages) {
      try {
        const publicPackage = decodeKeyPackageBytes(new Uint8Array(pkg.publicData))
        const privatePackage = deserializePrivatePackage(new Uint8Array(pkg.privateData))
        const state = await processWelcome(
          Buffer.from(welcomeData, 'base64'),
          publicPackage,
          privatePackage
        )

        await this.setGroupState(channelId, state)
        await consumeKeyPackage(pkg.id)
        await this.processPendingCommits(channelId)
        await this.client.replenishKeyPackages()
        return true
      } catch {
        continue
      }
    }

    return false
  }

  async handleCommit(channelId, commitData) {
    if (!commitData) {
      return false
    }

    const currentState = this.groupStates.get(channelId)
    if (!currentState) {
      const pending = this.pendingCommits.get(channelId) || []
      pending.push(commitData)
      this.pendingCommits.set(channelId, pending)
      return false
    }

    try {
      await initCipherSuite()
      const newState = await processCommitMessage(
        currentState,
        Buffer.from(commitData, 'base64')
      )
      await this.setGroupState(channelId, newState)
      return true
    } catch {
      return false
    }
  }

  async processPendingCommits(channelId) {
    if (!this.hasGroup(channelId)) {
      return
    }

    const pending = this.pendingCommits.get(channelId) || []
    if (pending.length === 0) {
      return
    }

    this.pendingCommits.set(channelId, [])
    for (const commitData of pending) {
      await this.handleCommit(channelId, commitData)
    }
  }

  async encryptForChannel(channelId, plaintext) {
    const currentState = this.groupStates.get(channelId)
    if (!currentState) {
      throw new Error(`No local MLS state for channel ${channelId}`)
    }

    const encrypted = await encryptMessage(currentState, plaintext)
    await this.setGroupState(channelId, encrypted.newState)

    return {
      ciphertext: uint8ToBase64(encrypted.ciphertext),
      epoch: encrypted.epoch
    }
  }

  async decryptForChannel(channelId, ciphertext) {
    const currentState = this.groupStates.get(channelId)
    if (!currentState) {
      return null
    }

    const decrypted = await decryptMessage(
      currentState,
      Buffer.from(ciphertext, 'base64')
    )
    if (!decrypted) {
      return null
    }

    await this.setGroupState(channelId, decrypted.newState)
    return decrypted.plaintext
  }

  hasGroup(channelId) {
    return this.groupStates.has(channelId)
  }

  async loadOrderedWelcomeKeyPackages(keyPackageRef) {
    const localPackages = await loadKeyPackages()
    if (!keyPackageRef || localPackages.length === 0) {
      return localPackages
    }

    const matching = []
    const remaining = []

    for (const pkg of localPackages) {
      const encoded = uint8ToBase64(new Uint8Array(pkg.publicData))
      if (encoded === keyPackageRef) {
        matching.push(pkg)
      } else {
        remaining.push(pkg)
      }
    }

    return [...matching, ...remaining]
  }

  async setGroupState(channelId, state) {
    this.groupStates.set(channelId, state)
    await saveGroupState(
      channelId,
      serializeGroupState(state),
      Number(state.groupContext.epoch)
    )
  }

  getChannelTopic(channelId) {
    return `chat:channel:${channelId}`
  }

  async pushToChannelWithAck(topic, event, payload) {
    const channelId = topic.startsWith('chat:channel:') ? topic.slice('chat:channel:'.length) : null
    if (!channelId) {
      return false
    }

    return await this.client.pushScopeEvent('channel', channelId, event, payload)
  }

  async emit(event, payload) {
    const handlers = [
      ...(this.handlers.get(event) || []),
      ...(this.handlers.get('*') || [])
    ]

    for (const handler of handlers) {
      await handler(payload)
    }
  }

  seenMessage(messageId) {
    return this.handledMessageIds.includes(messageId)
  }

  rememberMessage(messageId) {
    this.handledMessageIds.push(messageId)
    if (this.handledMessageIds.length > MAX_HANDLED_MESSAGE_IDS) {
      this.handledMessageIds.splice(
        0,
        this.handledMessageIds.length - MAX_HANDLED_MESSAGE_IDS
      )
    }
  }
}
