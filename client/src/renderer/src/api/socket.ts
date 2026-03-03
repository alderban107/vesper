import { Socket, Channel } from 'phoenix'
import { getServerUrl, getAccessToken } from './client'

let socket: Socket | null = null
let channels: Map<string, Channel> = new Map()

export function connectSocket(): Socket {
  if (socket?.isConnected()) return socket

  const serverUrl = getServerUrl()
  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/socket'

  socket = new Socket(wsUrl, {
    params: { token: getAccessToken() }
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

export function joinChannel(
  topic: string,
  onMessage: (event: string, payload: unknown) => void
): Channel {
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
    'mls_request_join', 'mls_commit', 'mls_welcome', 'mls_remove', 'incoming_call',
    'presence_state', 'presence_diff',
    'reaction_update',
    'message_edited', 'message_deleted',
    'message_pinned', 'message_unpinned',
    'mention',
    'new_conversation', 'dm_message',
    'unread_update', 'dm_unread_update'
  ]
  for (const event of CHAT_EVENTS) {
    channel.on(event, (payload) => onMessage(event, payload))
  }

  channel
    .join()
    .receive('ok', () => {
      console.log(`Joined ${topic}`)
    })
    .receive('error', (resp) => {
      console.error(`Failed to join ${topic}:`, resp)
    })

  channels.set(topic, channel)
  return channel
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
  'mls_request_join',
  'mls_commit',
  'mls_welcome'
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
