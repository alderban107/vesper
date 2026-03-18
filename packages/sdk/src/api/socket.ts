import { Socket, Channel } from 'phoenix'
import { getServerUrl, getAccessToken } from './client.js'

const CHAT_EVENTS = [
  'new_message', 'typing_start', 'typing_stop', 'disappearing_ttl_updated',
  'mls_request_join_all', 'mls_request_join', 'mls_resync_request', 'mls_eviction_request', 'mls_commit', 'mls_welcome', 'mls_remove',
  'mls_history_request', 'mls_history_bundle',
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
  'scope_mutation',
  'mls_history_request_pending', 'mls_history_bundle_pending',
  'unread_update', 'dm_unread_update',
  'server_membership_revoked',
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
  'error',
  'mls_request_join_all',
  'mls_request_join',
  'mls_resync_request',
  'mls_commit',
  'mls_welcome',
  'mls_remove'
] as const

export interface VesperSocketClientOptions {
  SocketCtor?: typeof Socket
  getAccessToken?: () => string | null
  getServerUrl?: () => string
  logger?: Pick<Console, 'error' | 'log'>
}

export class VesperSocketClient {
  private readonly SocketCtor: typeof Socket
  private readonly logger: Pick<Console, 'error' | 'log'>
  private readonly resolveAccessToken: () => string | null
  private readonly resolveServerUrl: () => string
  private socket: Socket | null = null
  private readonly channels = new Map<string, Channel>()
  private readonly openListeners = new Set<() => void>()

  constructor(options: VesperSocketClientOptions = {}) {
    this.SocketCtor = options.SocketCtor ?? Socket
    this.logger = options.logger ?? console
    this.resolveAccessToken = options.getAccessToken ?? getAccessToken
    this.resolveServerUrl = options.getServerUrl ?? getServerUrl
  }

  connect(): Socket {
    if (this.socket) {
      if (!this.socket.isConnected()) {
        this.socket.connect()
      }
      return this.socket
    }

    const serverUrl = this.resolveServerUrl()
    const wsUrl = serverUrl.replace(/^http/, 'ws') + '/socket'

    this.socket = new this.SocketCtor(wsUrl, {
      params: () => ({ token: this.resolveAccessToken() })
    })

    this.socket.onOpen(() => {
      for (const listener of this.openListeners) {
        listener()
      }
    })

    this.socket.connect()
    return this.socket
  }

  disconnect(): void {
    this.channels.forEach((channel) => channel.leave())
    this.channels.clear()
    this.socket?.disconnect()
    this.socket = null
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

    const existing = this.channels.get(topic)
    if (existing) {
      existing.leave()
      this.channels.delete(topic)
    }

    const channel = this.socket.channel(topic, {})

    for (const event of events) {
      channel.on(event, (payload) => onMessage(event, payload))
    }

    this.channels.set(topic, channel)

    const joinPush = channel.join()

    if (!awaitJoin) {
      joinPush
        .receive('ok', () => {
          this.logger.log(`Joined ${topic}`)
        })
        .receive('error', (resp) => {
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
        .receive('error', (resp) => {
          this.logger.error(`Failed to join ${topic}:`, resp)
          this.channels.delete(topic)
          reject(new Error(`Failed to join ${topic}`))
        })
        .receive('timeout', () => {
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
    const channel = this.channels.get(topic)
    if (channel) {
      channel.leave()
      this.channels.delete(topic)
    }
  }

  pushToChannel(topic: string, event: string, payload: object): void {
    const channel = this.channels.get(topic)
    if (channel) {
      channel.push(event, payload)
    }
  }

  getChannel(topic: string): Channel | undefined {
    return this.channels.get(topic)
  }

  onSocketOpen(listener: () => void): () => void {
    this.openListeners.add(listener)
    return () => {
      this.openListeners.delete(listener)
    }
  }

  joinVoiceChannel(
    topic: string,
    onMessage: (event: string, payload: unknown) => void
  ): Channel {
    return this.registerChannel(topic, onMessage, false, VOICE_EVENTS) as Channel
  }
}

const defaultSocketClient = new VesperSocketClient()

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

export function pushToChannel(topic: string, event: string, payload: object): void {
  defaultSocketClient.pushToChannel(topic, event, payload)
}

export function getChannel(topic: string): Channel | undefined {
  return defaultSocketClient.getChannel(topic)
}

export function onSocketOpen(listener: () => void): () => void {
  return defaultSocketClient.onSocketOpen(listener)
}

export function joinVoiceChannel(
  topic: string,
  onMessage: (event: string, payload: unknown) => void
): Channel {
  return defaultSocketClient.joinVoiceChannel(topic, onMessage)
}
