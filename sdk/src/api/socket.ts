import { Socket, Channel } from 'phoenix'
import { getServerUrl, getAccessToken } from './client.js'

const CHAT_EVENTS = [
  'new_message', 'typing_start', 'typing_stop', 'disappearing_ttl_updated',
  'sender_key_distribution',
  'incoming_call',
  'call_rejected',
  'presence_state', 'presence_diff',
  'channel_created', 'channel_updated', 'channel_deleted',
  'reaction_update',
  'message_edited', 'message_deleted',
  'message_pinned', 'message_unpinned',
  'mention',
  'new_conversation', 'dm_message',
  'dm_typing_start', 'dm_typing_stop',
  'scope_summary_updated',
  'scope_mutation',
  'unread_update', 'dm_unread_update',
  'server_membership_revoked',
  'server_members_updated',
  'device_approval_requested', 'device_updated',
  'emoji_created', 'emoji_deleted'
] as const

const VOICE_EVENTS = [
  'offer',
  'ice_candidate',
  'voice_state_update',
  'voice_key',
  'track_map',
  'incoming_call',
  'call_timeout',
  'call_rejected',
  'error'
] as const

export interface VesperSocketClientOptions {
  SocketCtor?: typeof Socket
  getAccessToken?: () => string | null
  getServerUrl?: () => string
  logger?: Pick<Console, 'error' | 'log'>
}

type PhoenixSocketLike = Socket & {
  onClose?: (listener: (event: unknown) => void) => unknown
  onError?: (listener: (error: unknown) => void) => unknown
}

type PhoenixChannelLike = Channel & {
  isJoined?: () => boolean
  isClosed?: () => boolean
  isLeaving?: () => boolean
}

export class VesperSocketClient {
  private readonly SocketCtor: typeof Socket
  private readonly logger: Pick<Console, 'error' | 'log'>
  private readonly resolveAccessToken: () => string | null
  private readonly resolveServerUrl: () => string
  private socket: Socket | null = null
  private socketUrl: string | null = null
  private socketToken: string | null = null
  private readonly channels = new Map<string, Channel>()
  private readonly channelListeners = new Map<
    string,
    Set<(event: string, payload: unknown) => void>
  >()
  private readonly openListeners = new Set<() => void>()
  private readonly closeListeners = new Set<(event: unknown) => void>()
  private readonly errorListeners = new Set<(error: unknown) => void>()

  constructor(options: VesperSocketClientOptions = {}) {
    this.SocketCtor = options.SocketCtor ?? Socket
    this.logger = options.logger ?? console
    this.resolveAccessToken = options.getAccessToken ?? getAccessToken
    this.resolveServerUrl = options.getServerUrl ?? getServerUrl
  }

  connect(): Socket {
    const serverUrl = this.resolveServerUrl()
    const wsUrl = serverUrl.replace(/^http/, 'ws') + '/socket'
    const accessToken = this.resolveAccessToken()

    if (this.socket) {
      const sameTransport =
        this.socketUrl === wsUrl &&
        this.socketToken === accessToken

      if (!sameTransport) {
        this.disconnect()
      } else {
        if (!this.socket.isConnected()) {
          this.socket.connect()
        }
        return this.socket
      }
    }

    const socket = new this.SocketCtor(wsUrl, {
      params: () => ({ token: this.resolveAccessToken() })
    })
    this.socket = socket
    this.socketUrl = wsUrl
    this.socketToken = accessToken

    socket.onOpen(() => {
      if (this.socket !== socket) return
      this.socketToken = this.resolveAccessToken()

      for (const listener of this.openListeners) {
        listener()
      }
    })

    ;(socket as PhoenixSocketLike).onClose?.((event: unknown) => {
      if (this.socket !== socket) return
      for (const listener of this.closeListeners) {
        listener(event)
      }
    })

    ;(socket as PhoenixSocketLike).onError?.((error: unknown) => {
      if (this.socket !== socket) return
      for (const listener of this.errorListeners) {
        listener(error)
      }
    })

    socket.connect()
    return socket
  }

  disconnect(): void {
    this.channels.forEach((channel) => channel.leave())
    this.channels.clear()
    this.channelListeners.clear()
    this.socket?.disconnect()
    this.socket = null
    this.socketUrl = null
    this.socketToken = null
  }

  private registerChannel(
    topic: string,
    onMessage: (event: string, payload: unknown) => void,
    awaitJoin: boolean,
    events: readonly string[]
  ): Channel | Promise<Channel> {
    if (!this.socket) {
      throw new Error('Socket not connected')
    }

    const listeners = this.channelListeners.get(topic) ?? new Set()
    listeners.add(onMessage)
    this.channelListeners.set(topic, listeners)

    const existing = this.channels.get(topic)
    if (existing) {
      if (awaitJoin && !this.isChannelJoined(existing)) {
        existing.leave()
        this.channels.delete(topic)
      } else if (!awaitJoin && !this.isChannelClosed(existing) && !this.isChannelLeaving(existing)) {
        return existing
      } else if (!awaitJoin) {
        existing.leave()
        this.channels.delete(topic)
      } else {
        return Promise.resolve(existing)
      }
    }

    const channel = this.socket.channel(topic, {})

    for (const event of events) {
      channel.on(event, (payload: unknown) => {
        const topicListeners = this.channelListeners.get(topic)
        if (!topicListeners) {
          return
        }

        for (const listener of topicListeners) {
          listener(event, payload)
        }
      })
    }

    this.channels.set(topic, channel)

    const joinPush = channel.join()

    if (!awaitJoin) {
      joinPush
        .receive('ok', () => {
          this.logger.log(`Joined ${topic}`)
        })
        .receive('error', (resp: unknown) => {
          this.logger.error(`Failed to join ${topic}:`, resp)
        })

      return channel
    }

    return new Promise<Channel>((resolve, reject) => {
      joinPush
        .receive('ok', () => {
          this.logger.log(`Joined ${topic}`)
          resolve(channel)
        })
        .receive('error', (resp: unknown) => {
          this.logger.error(`Failed to join ${topic}:`, resp)
          this.channelListeners.delete(topic)
          this.channels.delete(topic)
          reject(new Error(`Failed to join ${topic}`))
        })
        .receive('timeout', () => {
          this.channelListeners.delete(topic)
          this.channels.delete(topic)
          reject(new Error(`Timed out joining ${topic}`))
        })
    })
  }

  joinChannel(
    topic: string,
    onMessage: (event: string, payload: unknown) => void
  ): Channel {
    return this.registerChannel(topic, onMessage, false, CHAT_EVENTS) as Channel
  }

  async joinChannelWithAck(
    topic: string,
    onMessage: (event: string, payload: unknown) => void
  ): Promise<Channel> {
    return await (this.registerChannel(topic, onMessage, true, CHAT_EVENTS) as Promise<Channel>)
  }

  leaveChannel(topic: string): void {
    this.leaveChannelListener(topic)
  }

  leaveChannelListener(
    topic: string,
    onMessage?: (event: string, payload: unknown) => void
  ): void {
    const listeners = this.channelListeners.get(topic)
    if (listeners) {
      if (onMessage) {
        listeners.delete(onMessage)
        if (listeners.size > 0) {
          return
        }
      }

      this.channelListeners.delete(topic)
    }

    const channel = this.channels.get(topic)
    if (channel) {
      channel.leave()
      this.channels.delete(topic)
    }
  }

  pushToChannel(topic: string, event: string, payload: object): void {
    const channel = this.channels.get(topic)
    if (!channel) {
      return
    }

    try {
      channel.push(event, payload)
    } catch (error) {
      this.logger.error(`Failed to push ${event} to ${topic}:`, error)
    }
  }

  async pushToChannelWithAck(
    topic: string,
    event: string,
    payload: object
  ): Promise<boolean> {
    const channel = this.channels.get(topic)
    if (!channel) {
      return false
    }

    try {
      return await new Promise<boolean>((resolve) => {
        channel
          .push(event, payload)
          .receive('ok', () => resolve(true))
          .receive('error', () => resolve(false))
          .receive('timeout', () => resolve(false))
      })
    } catch {
      return false
    }
  }

  getChannel(topic: string): Channel | undefined {
    return this.channels.get(topic)
  }

  hasUsableChannel(topic: string): boolean {
    const channel = this.channels.get(topic)
    if (!channel) {
      return false
    }

    return !this.isChannelClosed(channel) && !this.isChannelLeaving(channel)
  }

  onSocketOpen(listener: () => void): () => void {
    this.openListeners.add(listener)
    return () => {
      this.openListeners.delete(listener)
    }
  }

  onSocketClose(listener: (event: unknown) => void): () => void {
    this.closeListeners.add(listener)
    return () => {
      this.closeListeners.delete(listener)
    }
  }

  onSocketError(listener: (error: unknown) => void): () => void {
    this.errorListeners.add(listener)
    return () => {
      this.errorListeners.delete(listener)
    }
  }

  joinVoiceChannel(
    topic: string,
    onMessage: (event: string, payload: unknown) => void
  ): Channel {
    return this.registerChannel(topic, onMessage, false, VOICE_EVENTS) as Channel
  }

  private isChannelJoined(channel: Channel): boolean {
    const candidate = channel as PhoenixChannelLike
    return typeof candidate.isJoined === 'function' ? candidate.isJoined() : true
  }

  private isChannelClosed(channel: Channel): boolean {
    const candidate = channel as PhoenixChannelLike
    return typeof candidate.isClosed === 'function' ? candidate.isClosed() : false
  }

  private isChannelLeaving(channel: Channel): boolean {
    const candidate = channel as PhoenixChannelLike
    return typeof candidate.isLeaving === 'function' ? candidate.isLeaving() : false
  }
}

const defaultSocketClient = new VesperSocketClient()

export function getDefaultSocketClient(): VesperSocketClient {
  return defaultSocketClient
}

export function connectSocket(): Socket {
  return defaultSocketClient.connect()
}

export function disconnectSocket(): void {
  defaultSocketClient.disconnect()
}

export function joinChannel(
  topic: string,
  onMessage: (event: string, payload: unknown) => void
): Channel {
  return defaultSocketClient.joinChannel(topic, onMessage)
}

export async function joinChannelWithAck(
  topic: string,
  onMessage: (event: string, payload: unknown) => void
): Promise<Channel> {
  return await defaultSocketClient.joinChannelWithAck(topic, onMessage)
}

export function leaveChannel(topic: string): void {
  defaultSocketClient.leaveChannel(topic)
}

export function leaveChannelListener(
  topic: string,
  onMessage?: (event: string, payload: unknown) => void
): void {
  defaultSocketClient.leaveChannelListener(topic, onMessage)
}

export function pushToChannel(topic: string, event: string, payload: object): void {
  defaultSocketClient.pushToChannel(topic, event, payload)
}

export async function pushToChannelWithAck(
  topic: string,
  event: string,
  payload: object
): Promise<boolean> {
  return await defaultSocketClient.pushToChannelWithAck(topic, event, payload)
}

export function getChannel(topic: string): Channel | undefined {
  return defaultSocketClient.getChannel(topic)
}

export function onSocketOpen(listener: () => void): () => void {
  return defaultSocketClient.onSocketOpen(listener)
}

export function onSocketClose(listener: (event: unknown) => void): () => void {
  return defaultSocketClient.onSocketClose(listener)
}

export function onSocketError(listener: (error: unknown) => void): () => void {
  return defaultSocketClient.onSocketError(listener)
}

export function joinVoiceChannel(
  topic: string,
  onMessage: (event: string, payload: unknown) => void
): Channel {
  return defaultSocketClient.joinVoiceChannel(topic, onMessage)
}
