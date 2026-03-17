import { Socket, Channel } from 'phoenix'
import { getServerUrl, getAccessToken } from './client'

let socket: Socket | null = null
let channels: Map<string, Channel> = new Map()
let openListeners: Set<() => void> = new Set()

export function connectSocket(): Socket {
  if (socket) {
    if (!socket.isConnected()) {
      socket.connect()
    }
    return socket
  }

  const serverUrl = getServerUrl()
  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/socket'

  socket = new Socket(wsUrl, {
    params: () => ({ token: getAccessToken() })
  })

  socket.onOpen(() => {
    for (const listener of openListeners) {
      listener()
    }
  })

  socket.connect()
  return socket
}

export function disconnectSocket(): void {
  channels.forEach((channel) => channel.leave())
  channels.clear()
  socket?.disconnect()
  socket = null
}

function registerChannel(
  topic: string,
  onMessage: (event: string, payload: unknown) => void,
  awaitJoin: boolean
): Channel | Promise<Channel> {
  if (!socket) throw new Error('Socket not connected')

  // Leave existing channel if any
  const existing = channels.get(topic)
  if (existing) {
    existing.leave()
    channels.delete(topic)
  }

  const channel = socket.channel(topic, {})

  const CHAT_EVENTS = [
    'new_message', 'typing_start', 'typing_stop', 'disappearing_ttl_updated',
    'mls_request_join_all', 'mls_request_join', 'mls_resync_request', 'mls_commit', 'mls_welcome', 'mls_remove',
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
    'device_approval_requested', 'device_updated',
    'emoji_created', 'emoji_deleted'
  ]
  for (const event of CHAT_EVENTS) {
    channel.on(event, (payload) => onMessage(event, payload))
  }

  channels.set(topic, channel)

  const joinPush = channel.join()

  if (!awaitJoin) {
    joinPush
      .receive('ok', () => {
        console.log(`Joined ${topic}`)
      })
      .receive('error', (resp) => {
        console.error(`Failed to join ${topic}:`, resp)
      })

    return channel
  }

  return new Promise<Channel>((resolve, reject) => {
    joinPush
      .receive('ok', () => {
        console.log(`Joined ${topic}`)
        resolve(channel)
      })
      .receive('error', (resp) => {
        console.error(`Failed to join ${topic}:`, resp)
        channels.delete(topic)
        reject(new Error(`Failed to join ${topic}`))
      })
      .receive('timeout', () => {
        channels.delete(topic)
        reject(new Error(`Timed out joining ${topic}`))
      })
  })
}

export function joinChannel(
  topic: string,
  onMessage: (event: string, payload: unknown) => void
): Channel {
  return registerChannel(topic, onMessage, false) as Channel
}

export async function joinChannelWithAck(
  topic: string,
  onMessage: (event: string, payload: unknown) => void
): Promise<Channel> {
  return await (registerChannel(topic, onMessage, true) as Promise<Channel>)
}

export function leaveChannel(topic: string): void {
  const channel = channels.get(topic)
  if (channel) {
    channel.leave()
    channels.delete(topic)
  }
}

export function pushToChannel(topic: string, event: string, payload: object): void {
  const channel = channels.get(topic)
  if (channel) {
    channel.push(event, payload)
  }
}

export function getChannel(topic: string): Channel | undefined {
  return channels.get(topic)
}

export function onSocketOpen(listener: () => void): () => void {
  openListeners.add(listener)
  return () => {
    openListeners.delete(listener)
  }
}

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
]

export function joinVoiceChannel(
  topic: string,
  onMessage: (event: string, payload: unknown) => void
): Channel {
  if (!socket) throw new Error('Socket not connected')

  const existing = channels.get(topic)
  if (existing) {
    existing.leave()
    channels.delete(topic)
  }

  const channel = socket.channel(topic, {})

  for (const event of VOICE_EVENTS) {
    channel.on(event, (payload) => onMessage(event, payload))
  }

  channel
    .join()
    .receive('ok', () => {
      console.log(`Joined voice ${topic}`)
    })
    .receive('error', (resp) => {
      console.error(`Failed to join voice ${topic}:`, resp)
      onMessage('join_error', resp)
    })

  channels.set(topic, channel)
  return channel
}
