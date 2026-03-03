import { create } from 'zustand'
import { connectSocket, joinVoiceChannel, leaveChannel, pushToChannel } from '../api/socket'
import { WebRTCManager } from '../voice/webrtc'
import { AudioManager } from '../voice/audio'
import { VoiceEncryption } from '../voice/encryption'
import { useAuthStore } from './authStore'
import { useCryptoStore } from './cryptoStore'

export interface VoiceParticipant {
  user_id: string
  muted: boolean
  speaking?: boolean
}

interface IncomingCall {
  callerId: string
  conversationId: string
}

interface VoiceState {
  state: 'idle' | 'connecting' | 'connected' | 'ringing' | 'in_call'
  roomId: string | null
  roomType: 'channel' | 'dm' | null
  participants: VoiceParticipant[]
  muted: boolean
  deafened: boolean
  incomingCall: IncomingCall | null
  trackMap: Record<string, string>
  inputDeviceId: string | null
  outputDeviceId: string | null

  joinVoiceChannel: (channelId: string) => Promise<void>
  startDmCall: (conversationId: string) => Promise<void>
  acceptCall: (conversationId: string) => Promise<void>
  rejectCall: () => void
  disconnect: () => void
  toggleMute: () => void
  toggleDeafen: () => void
  setIncomingCall: (call: IncomingCall | null) => void
  setInputDevice: (deviceId: string | null) => void
  setOutputDevice: (deviceId: string | null) => void
}

let webrtcManager: WebRTCManager | null = null
let audioManager: AudioManager | null = null
let voiceEncryption: VoiceEncryption | null = null

function getIceServers(): RTCIceServer[] {
  return [{ urls: 'stun:stun.l.google.com:19302' }]
}

function cleanup(get: () => VoiceState): void {
  const { roomId, roomType } = get()

  if (roomId) {
    const topic = roomType === 'dm' ? `voice:dm:${roomId}` : `voice:channel:${roomId}`
    leaveChannel(topic)
  }

  webrtcManager?.destroy()
  webrtcManager = null
  audioManager?.destroy()
  audioManager = null
  voiceEncryption?.destroy()
  voiceEncryption = null
}

export const useVoiceStore = create<VoiceState>((set, get) => ({
  state: 'idle',
  roomId: null,
  roomType: null,
  participants: [],
  muted: false,
  deafened: false,
  incomingCall: null,
  trackMap: {},
  inputDeviceId: localStorage.getItem('voice:inputDeviceId'),
  outputDeviceId: localStorage.getItem('voice:outputDeviceId'),

  joinVoiceChannel: async (channelId) => {
    // If already in voice, disconnect first
    if (get().state !== 'idle') {
      cleanup(get)
    }

    set({ state: 'connecting', roomId: channelId, roomType: 'channel' })

    connectSocket()
    initVoice(channelId, 'channel', set, get)
  },

  startDmCall: async (conversationId) => {
    if (get().state !== 'idle') {
      cleanup(get)
    }

    set({ state: 'connecting', roomId: conversationId, roomType: 'dm' })

    connectSocket()
    initVoice(conversationId, 'dm', set, get)

    // After joining, send call_ring
    const topic = `voice:dm:${conversationId}`
    pushToChannel(topic, 'call_ring', {})
    set({ state: 'ringing' })
  },

  acceptCall: async (conversationId) => {
    set({ state: 'connecting', roomId: conversationId, roomType: 'dm', incomingCall: null })

    connectSocket()
    initVoice(conversationId, 'dm', set, get)

    const topic = `voice:dm:${conversationId}`
    pushToChannel(topic, 'call_accept', {})
  },

  rejectCall: () => {
    const incoming = get().incomingCall
    if (incoming) {
      // Optionally push rejection — but since we're not in the voice channel,
      // the caller's ring timeout will handle it
      set({ incomingCall: null })
    }
  },

  disconnect: () => {
    cleanup(get)
    set({
      state: 'idle',
      roomId: null,
      roomType: null,
      participants: [],
      muted: false,
      deafened: false,
      trackMap: {}
    })
  },

  toggleMute: () => {
    const muted = !get().muted
    set({ muted })
    webrtcManager?.setMuted(muted)

    const { roomId, roomType } = get()
    if (roomId) {
      const topic = roomType === 'dm' ? `voice:dm:${roomId}` : `voice:channel:${roomId}`
      pushToChannel(topic, 'mute', { muted })
    }
  },

  toggleDeafen: () => {
    const deafened = !get().deafened
    set({ deafened })
    audioManager?.setDeafened(deafened)

    // If deafening, also mute mic
    if (deafened && !get().muted) {
      set({ muted: true })
      webrtcManager?.setMuted(true)
      const { roomId, roomType } = get()
      if (roomId) {
        const topic = roomType === 'dm' ? `voice:dm:${roomId}` : `voice:channel:${roomId}`
        pushToChannel(topic, 'mute', { muted: true })
      }
    }
  },

  setIncomingCall: (call) => {
    set({ incomingCall: call })
  },

  setInputDevice: (deviceId) => {
    if (deviceId) {
      localStorage.setItem('voice:inputDeviceId', deviceId)
    } else {
      localStorage.removeItem('voice:inputDeviceId')
    }
    set({ inputDeviceId: deviceId })
  },

  setOutputDevice: (deviceId) => {
    if (deviceId) {
      localStorage.setItem('voice:outputDeviceId', deviceId)
    } else {
      localStorage.removeItem('voice:outputDeviceId')
    }
    set({ outputDeviceId: deviceId })
    // Apply to all active audio elements
    audioManager?.setOutputDevice(deviceId)
  }
}))

function initVoice(
  roomId: string,
  roomType: 'channel' | 'dm',
  set: (partial: Partial<VoiceState>) => void,
  get: () => VoiceState
): void {
  webrtcManager = new WebRTCManager()
  audioManager = new AudioManager()
  voiceEncryption = new VoiceEncryption()
  voiceEncryption.init()

  const topic = roomType === 'dm' ? `voice:dm:${roomId}` : `voice:channel:${roomId}`

  webrtcManager.init(getIceServers(), {
    onTrack: (event) => {
      const track = event.track
      if (track.kind === 'audio') {
        audioManager?.addRemoteTrack(track.id, track)
        // Apply output device if set
        const outputId = get().outputDeviceId
        if (outputId) audioManager?.setOutputDevice(outputId)
        // Apply E2EE decryption transform to incoming audio
        voiceEncryption?.applyReceiverTransform(event.receiver)
      }
    },
    onIceCandidate: (candidate) => {
      pushToChannel(topic, 'ice_candidate', {
        candidate: {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
          usernameFragment: candidate.usernameFragment
        }
      })
    },
    onConnectionStateChange: (state) => {
      if (state === 'connected') {
        set({ state: get().roomType === 'dm' ? 'in_call' : 'connected' })
      } else if (state === 'failed' || state === 'closed') {
        get().disconnect()
      }
    }
  })

  joinVoiceChannel(topic, async (event, payload) => {
    const data = payload as Record<string, unknown>

    if (event === 'offer') {
      try {
        const inputId = get().inputDeviceId ?? undefined
        await webrtcManager!.startAudio(inputId)

        // Set up speaking detection for local mic
        const localStream = webrtcManager!.getLocalStream()
        if (localStream) audioManager?.setLocalStream(localStream)

        // Apply E2EE encryption transform to outgoing audio
        for (const sender of webrtcManager!.getSenders()) {
          if (sender.track?.kind === 'audio') {
            voiceEncryption?.applySenderTransform(sender)
          }
        }

        const answerSdp = await webrtcManager!.handleOffer(data.sdp as string)
        pushToChannel(topic, 'answer', { sdp: answerSdp })

        if (data.track_map) {
          set({ trackMap: data.track_map as Record<string, string> })
        }

        // Start speaking detection polling
        const userId = useAuthStore.getState().user?.id
        audioManager?.onSpeakingChange((levels) => {
          const { participants, trackMap } = get()
          let changed = false
          const updated = participants.map((p) => {
            let speaking = false
            if (p.user_id === userId) {
              speaking = levels.get('__local__') ?? false
            } else {
              // Find this user's track via trackMap (mid → userId)
              for (const [trackId, isSpeaking] of levels) {
                if (trackId === '__local__') continue
                // Match trackId to userId via trackMap
                const mappedUserId = Object.entries(trackMap).find(
                  ([, uid]) => uid === p.user_id
                )
                if (mappedUserId) {
                  speaking = isSpeaking
                  break
                }
              }
            }
            if (p.speaking !== speaking) changed = true
            return changed || p.speaking !== speaking ? { ...p, speaking } : p
          })
          if (changed) set({ participants: updated })
        })

        // Set up MLS group for voice E2EE
        setupVoiceE2EE(roomId, topic)
      } catch (err) {
        console.error('Failed to handle offer:', err)
        get().disconnect()
      }
    } else if (event === 'ice_candidate') {
      const candidate = data.candidate as Record<string, unknown>
      webrtcManager?.addIceCandidate({
        candidate: candidate.candidate as string,
        sdpMid: candidate.sdpMid as string | null,
        sdpMLineIndex: candidate.sdpMLineIndex as number | null,
        usernameFragment: candidate.usernameFragment as string | null
      }).catch(() => {})
    } else if (event === 'voice_state_update') {
      set({ participants: data.participants as VoiceParticipant[] })
    } else if (event === 'call_timeout') {
      get().disconnect()
    } else if (event === 'call_rejected') {
      get().disconnect()
    } else if (event === 'incoming_call') {
      const userId = useAuthStore.getState().user?.id
      if (data.caller_id !== userId) {
        set({
          incomingCall: {
            callerId: data.caller_id as string,
            conversationId: data.conversation_id as string
          }
        })
      }
    } else if (event === 'mls_request_join') {
      handleVoiceMlsJoinRequest(roomId, data, topic)
    } else if (event === 'mls_commit') {
      const senderId = data.sender_id as string
      const userId = useAuthStore.getState().user?.id
      if (senderId !== userId) {
        const crypto = useCryptoStore.getState()
        await crypto.handleCommit(roomId, data.commit_data as string)
        // Key rotation — derive new voice key
        const newKey = await crypto.getVoiceKey(roomId)
        if (newKey) voiceEncryption?.setKey(newKey)
      }
    } else if (event === 'mls_welcome') {
      const recipientId = data.recipient_id as string
      const userId = useAuthStore.getState().user?.id
      if (recipientId === userId) {
        const crypto = useCryptoStore.getState()
        await crypto.handleWelcome(roomId, data.welcome_data as string)
        const voiceKey = await crypto.getVoiceKey(roomId)
        if (voiceKey) voiceEncryption?.setKey(voiceKey)
      }
    } else if (event === 'join_error') {
      console.error('Voice join error:', data)
      set({
        state: 'idle',
        roomId: null,
        roomType: null
      })
    }
  })
}

async function setupVoiceE2EE(roomId: string, topic: string): Promise<void> {
  const crypto = useCryptoStore.getState()

  // Try to join existing MLS group or create one
  await crypto.ensureGroupMembership(roomId)

  if (!crypto.hasGroup(roomId)) {
    // No group exists — create one and request others to join
    await crypto.createGroup(roomId)
    pushToChannel(topic, 'mls_request_join', {})
  }

  // Derive and set voice key
  const voiceKey = await crypto.getVoiceKey(roomId)
  if (voiceKey) {
    voiceEncryption?.setKey(voiceKey)
  }
}

async function handleVoiceMlsJoinRequest(
  roomId: string,
  msg: Record<string, unknown>,
  topic: string
): Promise<void> {
  const userId = msg.user_id as string
  const crypto = useCryptoStore.getState()

  if (!crypto.hasGroup(roomId)) return

  const result = (await crypto.handleJoinRequest(roomId, userId)) as unknown as {
    commitBytes: string
    welcomeBytes: string | null
  } | void

  if (!result) return

  pushToChannel(topic, 'mls_commit', {
    commit_data: result.commitBytes
  })

  if (result.welcomeBytes) {
    pushToChannel(topic, 'mls_welcome', {
      recipient_id: userId,
      welcome_data: result.welcomeBytes
    })
  }

  // Key rotated after adding member — update our voice key
  const newKey = await crypto.getVoiceKey(roomId)
  if (newKey) voiceEncryption?.setKey(newKey)
}
