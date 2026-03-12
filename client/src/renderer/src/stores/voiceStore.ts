import { create } from 'zustand'
import { connectSocket, joinVoiceChannel, leaveChannel, pushToChannel } from '../api/socket'
import { WebRTCManager, type LocalVideoMode } from '../voice/webrtc'
import { AudioManager } from '../voice/audio'
import { VoiceEncryption } from '../voice/encryption'
import { useAuthStore } from './authStore'
import { useCryptoStore } from './cryptoStore'

const INPUT_DEVICE_KEY = 'voice:inputDeviceId'
const OUTPUT_DEVICE_KEY = 'voice:outputDeviceId'
const ECHO_CANCELLATION_KEY = 'voice:echoCancellation'
const NOISE_SUPPRESSION_KEY = 'voice:noiseSuppression'
const AUTO_GAIN_CONTROL_KEY = 'voice:autoGainControl'
const INPUT_VOLUME_KEY = 'voice:inputVolume'
const OUTPUT_VOLUME_KEY = 'voice:outputVolume'
const INPUT_SENSITIVITY_KEY = 'voice:inputSensitivity'
const NOISE_GATE_ENABLED_KEY = 'voice:noiseGateEnabled'
const NOISE_GATE_THRESHOLD_DB_KEY = 'voice:noiseGateThresholdDb'
const REMOTE_VOLUMES_KEY = 'voice:remoteVolumes'

function readString(key: string): string | null {
  return localStorage.getItem(key)
}

function readBoolean(key: string, fallback: boolean): boolean {
  const value = localStorage.getItem(key)
  return value === null ? fallback : value === 'true'
}

function readNumber(key: string, fallback: number): number {
  const value = localStorage.getItem(key)
  if (value === null) {
    return fallback
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function readRemoteVolumes(): Record<string, number> {
  try {
    const raw = localStorage.getItem(REMOTE_VOLUMES_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed as Record<string, number> : {}
  } catch {
    return {}
  }
}

function clampNoiseGateThresholdDb(value: number): number {
  return Math.max(-80, Math.min(-20, value))
}

export interface VoicePreferences {
  deviceId: string | null
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
  inputVolume: number
  noiseGateEnabled: boolean
  noiseGateThresholdDb: number
}

export interface VoiceParticipant {
  user_id: string
  muted: boolean
  speaking?: boolean
  audio_track_id?: string | null
  video_track_id?: string | null
}

export type VoiceConnectionQuality = 'good' | 'fair' | 'poor' | 'unknown'
export type VoiceVideoMode = 'none' | 'camera' | 'screen'

export interface VoiceTrackOwner {
  user_id: string
  kind: 'audio' | 'video'
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
  trackMap: Record<string, VoiceTrackOwner>
  trackIdsByMid: Record<string, string>
  videoMode: VoiceVideoMode
  cameraEnabled: boolean
  screenShareEnabled: boolean
  localVideoStream: MediaStream | null
  remoteVideoStreams: Record<string, MediaStream>
  inputDeviceId: string | null
  outputDeviceId: string | null
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
  inputVolume: number
  outputVolume: number
  inputSensitivity: number
  noiseGateEnabled: boolean
  noiseGateThresholdDb: number
  errorMessage: string | null
  remoteVolumes: Record<string, number>
  connectionQuality: VoiceConnectionQuality
  roundTripMs: number | null
  packetLossPct: number | null
  jitterMs: number | null
  inboundBitrateKbps: number | null
  outboundBitrateKbps: number | null

  joinVoiceChannel: (channelId: string) => Promise<void>
  startDmCall: (conversationId: string) => Promise<void>
  acceptCall: (conversationId: string) => Promise<void>
  rejectCall: () => void
  disconnect: () => void
  toggleMute: () => void
  toggleDeafen: () => void
  toggleCamera: () => Promise<void>
  toggleScreenShare: () => Promise<void>
  stopVideoShare: () => Promise<void>
  setIncomingCall: (call: IncomingCall | null) => void
  handleDmCallRejected: (conversationId: string) => void
  setInputDevice: (deviceId: string | null) => void
  setOutputDevice: (deviceId: string | null) => void
  setEchoCancellation: (enabled: boolean) => void
  setNoiseSuppression: (enabled: boolean) => void
  setAutoGainControl: (enabled: boolean) => void
  setInputVolume: (volume: number) => void
  setOutputVolume: (volume: number) => void
  setInputSensitivity: (value: number) => void
  setNoiseGateEnabled: (enabled: boolean) => void
  setNoiseGateThresholdDb: (value: number) => void
  setRemoteVolume: (userId: string, volume: number) => void
}

let webrtcManager: WebRTCManager | null = null
let audioManager: AudioManager | null = null
let voiceEncryption: VoiceEncryption | null = null
let statsPollInterval: ReturnType<typeof setInterval> | null = null

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

  if (statsPollInterval) {
    clearInterval(statsPollInterval)
    statsPollInterval = null
  }
}

function buildVoicePreferences(state: VoiceState): VoicePreferences {
  return {
    deviceId: state.inputDeviceId,
    echoCancellation: state.echoCancellation,
    noiseSuppression: state.noiseSuppression,
    autoGainControl: state.autoGainControl,
    inputVolume: state.inputVolume,
    noiseGateEnabled: state.noiseGateEnabled,
    noiseGateThresholdDb: state.noiseGateThresholdDb
  }
}

async function refreshLiveAudioInput(state: VoiceState): Promise<void> {
  try {
    await webrtcManager?.updateAudioInput(buildVoicePreferences(state))
    const stream = webrtcManager?.getLocalStream()
    if (stream) {
      audioManager?.setLocalStream(stream)
    }
  } catch {
    useVoiceStore.setState({
      errorMessage: 'Could not switch to that microphone. Try another input device.'
    })
  }
}

function deriveConnectionQuality(
  roundTripMs: number | null,
  packetLossPct: number | null
): VoiceConnectionQuality {
  if (roundTripMs === null && packetLossPct === null) {
    return 'unknown'
  }

  if ((roundTripMs ?? 0) > 300 || (packetLossPct ?? 0) > 8) {
    return 'poor'
  }

  if ((roundTripMs ?? 0) > 170 || (packetLossPct ?? 0) > 3) {
    return 'fair'
  }

  return 'good'
}

function buildResetConnectionStats(): Pick<
  VoiceState,
  'connectionQuality' | 'roundTripMs' | 'packetLossPct' | 'jitterMs' | 'inboundBitrateKbps' | 'outboundBitrateKbps'
> {
  return {
    connectionQuality: 'unknown',
    roundTripMs: null,
    packetLossPct: null,
    jitterMs: null,
    inboundBitrateKbps: null,
    outboundBitrateKbps: null
  }
}

function parseTrackMap(rawTrackMap: unknown): Record<string, VoiceTrackOwner> {
  if (!rawTrackMap || typeof rawTrackMap !== 'object') {
    return {}
  }

  const parsed: Record<string, VoiceTrackOwner> = {}

  for (const [mid, rawEntry] of Object.entries(rawTrackMap as Record<string, unknown>)) {
    if (typeof rawEntry === 'string') {
      parsed[mid] = { user_id: rawEntry, kind: 'audio' }
      continue
    }

    if (!rawEntry || typeof rawEntry !== 'object') {
      continue
    }

    const entry = rawEntry as Record<string, unknown>
    const userId = typeof entry.user_id === 'string' ? entry.user_id : null
    const kind = entry.kind === 'video' ? 'video' : 'audio'

    if (userId) {
      parsed[mid] = { user_id: userId, kind }
    }
  }

  return parsed
}

function findMappedMid(
  trackMap: Record<string, VoiceTrackOwner>,
  userId: string,
  kind: 'audio' | 'video'
): string | undefined {
  return Object.entries(trackMap).find(([, owner]) => owner.user_id === userId && owner.kind === kind)?.[0]
}

async function applyVideoMode(
  mode: VoiceVideoMode,
  set: (partial: Partial<VoiceState> | ((state: VoiceState) => Partial<VoiceState>)) => void,
  get: () => VoiceState
): Promise<void> {
  const currentState = get()
  if (currentState.videoMode === mode && (mode !== 'none' || currentState.localVideoStream)) {
    return
  }

  if (!webrtcManager) {
    return
  }

  if (mode === 'none') {
    await webrtcManager.stopVideo().catch(() => {})
    set({
      videoMode: 'none',
      cameraEnabled: false,
      screenShareEnabled: false,
      localVideoStream: null
    })
    return
  }

  try {
    const localVideoStream = await webrtcManager.startVideo(mode as LocalVideoMode)
    const localTrack = localVideoStream.getVideoTracks()[0] ?? null

    if (localTrack) {
      localTrack.onended = () => {
        if (get().videoMode === mode) {
          void applyVideoMode('none', set, get)
        }
      }
    }

    for (const sender of webrtcManager.getSenders()) {
      if (sender.track?.kind === 'video') {
        voiceEncryption?.applySenderTransform(sender, 'video')
      }
    }

    set({
      videoMode: mode,
      cameraEnabled: mode === 'camera',
      screenShareEnabled: mode === 'screen',
      localVideoStream
    })
  } catch {
    await webrtcManager.stopVideo().catch(() => {})
    set({
      videoMode: 'none',
      cameraEnabled: false,
      screenShareEnabled: false,
      localVideoStream: null,
      errorMessage:
        mode === 'screen'
          ? 'Could not start screen share. Check screen capture permissions and try again.'
          : 'Could not start camera. Check camera permissions and try again.'
    })
  }
}

function startStatsPolling(
  set: (partial: Partial<VoiceState>) => void,
  get: () => VoiceState
): void {
  if (statsPollInterval) {
    clearInterval(statsPollInterval)
    statsPollInterval = null
  }

  const updateStats = async (): Promise<void> => {
    const roomState = get().state
    if (!['connected', 'in_call', 'ringing', 'connecting'].includes(roomState)) {
      return
    }

    const stats = await webrtcManager?.getConnectionStats()
    if (!stats) {
      set(buildResetConnectionStats())
      return
    }

    set({
      roundTripMs: stats.roundTripMs,
      packetLossPct: stats.packetLossPct,
      jitterMs: stats.jitterMs,
      inboundBitrateKbps: stats.inboundBitrateKbps,
      outboundBitrateKbps: stats.outboundBitrateKbps,
      connectionQuality: deriveConnectionQuality(stats.roundTripMs, stats.packetLossPct)
    })
  }

  void updateStats()
  statsPollInterval = setInterval(() => {
    void updateStats()
  }, 3000)
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
  trackIdsByMid: {},
  videoMode: 'none',
  cameraEnabled: false,
  screenShareEnabled: false,
  localVideoStream: null,
  remoteVideoStreams: {},
  inputDeviceId: readString(INPUT_DEVICE_KEY),
  outputDeviceId: readString(OUTPUT_DEVICE_KEY),
  echoCancellation: readBoolean(ECHO_CANCELLATION_KEY, true),
  noiseSuppression: readBoolean(NOISE_SUPPRESSION_KEY, true),
  autoGainControl: readBoolean(AUTO_GAIN_CONTROL_KEY, true),
  inputVolume: readNumber(INPUT_VOLUME_KEY, 100),
  outputVolume: readNumber(OUTPUT_VOLUME_KEY, 100),
  inputSensitivity: readNumber(INPUT_SENSITIVITY_KEY, 42),
  noiseGateEnabled: readBoolean(NOISE_GATE_ENABLED_KEY, true),
  noiseGateThresholdDb: clampNoiseGateThresholdDb(readNumber(NOISE_GATE_THRESHOLD_DB_KEY, -52)),
  errorMessage: null,
  remoteVolumes: readRemoteVolumes(),
  ...buildResetConnectionStats(),

  joinVoiceChannel: async (channelId) => {
    // If already in voice, disconnect first
    if (get().state !== 'idle') {
      cleanup(get)
    }

    set({
      state: 'connecting',
      roomId: channelId,
      roomType: 'channel',
      participants: [],
      trackMap: {},
      trackIdsByMid: {},
      videoMode: 'none',
      cameraEnabled: false,
      screenShareEnabled: false,
      localVideoStream: null,
      remoteVideoStreams: {},
      errorMessage: null,
      ...buildResetConnectionStats()
    })

    connectSocket()
    initVoice(channelId, 'channel', set, get)
  },

  startDmCall: async (conversationId) => {
    if (get().state !== 'idle') {
      cleanup(get)
    }

    set({
      state: 'connecting',
      roomId: conversationId,
      roomType: 'dm',
      participants: [],
      trackMap: {},
      trackIdsByMid: {},
      videoMode: 'none',
      cameraEnabled: false,
      screenShareEnabled: false,
      localVideoStream: null,
      remoteVideoStreams: {},
      errorMessage: null,
      ...buildResetConnectionStats()
    })

    connectSocket()
    initVoice(conversationId, 'dm', set, get)

    // After joining, send call_ring
    const topic = `voice:dm:${conversationId}`
    pushToChannel(topic, 'call_ring', {})
    set({ state: 'ringing' })
  },

  acceptCall: async (conversationId) => {
    set({
      state: 'connecting',
      roomId: conversationId,
      roomType: 'dm',
      incomingCall: null,
      participants: [],
      trackMap: {},
      trackIdsByMid: {},
      videoMode: 'none',
      cameraEnabled: false,
      screenShareEnabled: false,
      localVideoStream: null,
      remoteVideoStreams: {},
      errorMessage: null,
      ...buildResetConnectionStats()
    })

    connectSocket()
    initVoice(conversationId, 'dm', set, get)

    const topic = `voice:dm:${conversationId}`
    pushToChannel(topic, 'call_accept', {})
  },

  rejectCall: () => {
    const incoming = get().incomingCall
    if (incoming) {
      pushToChannel(`dm:${incoming.conversationId}`, 'call_reject', {})
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
      trackMap: {},
      trackIdsByMid: {},
      videoMode: 'none',
      cameraEnabled: false,
      screenShareEnabled: false,
      localVideoStream: null,
      remoteVideoStreams: {},
      ...buildResetConnectionStats()
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

  toggleCamera: async () => {
    const { state, videoMode } = get()
    if (state !== 'connected' && state !== 'in_call') {
      return
    }

    const nextMode: VoiceVideoMode = videoMode === 'camera' ? 'none' : 'camera'
    await applyVideoMode(nextMode, set, get)
  },

  toggleScreenShare: async () => {
    const { state, videoMode } = get()
    if (state !== 'connected' && state !== 'in_call') {
      return
    }

    const nextMode: VoiceVideoMode = videoMode === 'screen' ? 'none' : 'screen'
    await applyVideoMode(nextMode, set, get)
  },

  stopVideoShare: async () => {
    await applyVideoMode('none', set, get)
  },

  setIncomingCall: (call) => {
    set({ incomingCall: call })
  },

  handleDmCallRejected: (conversationId) => {
    const state = get()

    if (state.incomingCall?.conversationId === conversationId) {
      set({ incomingCall: null })
      return
    }

    if (
      state.roomType === 'dm' &&
      state.roomId === conversationId &&
      (state.state === 'connecting' || state.state === 'ringing')
    ) {
      get().disconnect()
    }
  },

  setInputDevice: (deviceId) => {
    if (deviceId) {
      localStorage.setItem(INPUT_DEVICE_KEY, deviceId)
    } else {
      localStorage.removeItem(INPUT_DEVICE_KEY)
    }
    set({ inputDeviceId: deviceId })
    void refreshLiveAudioInput(get())
  },

  setOutputDevice: (deviceId) => {
    if (deviceId) {
      localStorage.setItem(OUTPUT_DEVICE_KEY, deviceId)
    } else {
      localStorage.removeItem(OUTPUT_DEVICE_KEY)
    }
    set({ outputDeviceId: deviceId })
    audioManager?.setOutputDevice(deviceId)
  },

  setEchoCancellation: (enabled) => {
    localStorage.setItem(ECHO_CANCELLATION_KEY, String(enabled))
    set({ echoCancellation: enabled })
    void refreshLiveAudioInput(get())
  },

  setNoiseSuppression: (enabled) => {
    localStorage.setItem(NOISE_SUPPRESSION_KEY, String(enabled))
    set({ noiseSuppression: enabled })
    void refreshLiveAudioInput(get())
  },

  setAutoGainControl: (enabled) => {
    localStorage.setItem(AUTO_GAIN_CONTROL_KEY, String(enabled))
    set({ autoGainControl: enabled })
    void refreshLiveAudioInput(get())
  },

  setInputVolume: (volume) => {
    const nextVolume = Math.max(0, Math.min(200, volume))
    localStorage.setItem(INPUT_VOLUME_KEY, String(nextVolume))
    set({ inputVolume: nextVolume })
    webrtcManager?.setInputVolume(nextVolume)
  },

  setOutputVolume: (volume) => {
    const nextVolume = Math.max(0, Math.min(200, volume))
    localStorage.setItem(OUTPUT_VOLUME_KEY, String(nextVolume))
    set({ outputVolume: nextVolume })
    audioManager?.setOutputVolume(nextVolume)
  },

  setInputSensitivity: (value) => {
    const nextValue = Math.max(0, Math.min(100, value))
    localStorage.setItem(INPUT_SENSITIVITY_KEY, String(nextValue))
    set({ inputSensitivity: nextValue })
    audioManager?.setSpeakingSensitivity(nextValue)
  },

  setNoiseGateEnabled: (enabled) => {
    localStorage.setItem(NOISE_GATE_ENABLED_KEY, String(enabled))
    set({ noiseGateEnabled: enabled })
    webrtcManager?.setNoiseGateEnabled(enabled)
  },

  setNoiseGateThresholdDb: (value) => {
    const nextValue = clampNoiseGateThresholdDb(value)
    localStorage.setItem(NOISE_GATE_THRESHOLD_DB_KEY, String(nextValue))
    set({ noiseGateThresholdDb: nextValue })
    webrtcManager?.setNoiseGateThresholdDb(nextValue)
  },

  setRemoteVolume: (userId, volume) => {
    const nextVolume = Math.max(0, Math.min(200, volume))
    set((state) => {
      const remoteVolumes = { ...state.remoteVolumes, [userId]: nextVolume }
      localStorage.setItem(REMOTE_VOLUMES_KEY, JSON.stringify(remoteVolumes))

      const trackId = state.participants.find((participant) => participant.user_id === userId)?.audio_track_id
      if (trackId) {
        audioManager?.setStreamVolume(trackId, nextVolume)
      }

      return { remoteVolumes }
    })
  }
}))

function initVoice(
  roomId: string,
  roomType: 'channel' | 'dm',
  set: (partial: Partial<VoiceState> | ((state: VoiceState) => Partial<VoiceState>)) => void,
  get: () => VoiceState
): void {
  webrtcManager = new WebRTCManager()
  audioManager = new AudioManager()
  voiceEncryption = new VoiceEncryption()
  voiceEncryption.init()
  audioManager.setOutputVolume(get().outputVolume)
  audioManager.setSpeakingSensitivity(get().inputSensitivity)

  const topic = roomType === 'dm' ? `voice:dm:${roomId}` : `voice:channel:${roomId}`

  webrtcManager.init(getIceServers(), {
    onTrack: (event) => {
      const track = event.track
      const mid = event.transceiver?.mid ?? null
      const owner = mid ? get().trackMap[mid] : undefined

      if (mid) {
        set((state) => ({ trackIdsByMid: { ...state.trackIdsByMid, [mid]: track.id } }))
      }

      if (track.kind === 'audio') {
        audioManager?.addRemoteTrack(track.id, track)
        if (owner?.user_id && owner.kind === 'audio') {
          const storedVolume = get().remoteVolumes[owner.user_id]
          if (storedVolume !== undefined) {
            audioManager?.setStreamVolume(track.id, storedVolume)
          }
          set((state) => ({
            participants: state.participants.map((participant) =>
              participant.user_id === owner.user_id
                ? { ...participant, audio_track_id: track.id }
                : participant
            )
          }))
        }

        const outputId = get().outputDeviceId
        if (outputId) {
          audioManager?.setOutputDevice(outputId)
        }
        voiceEncryption?.applyReceiverTransform(event.receiver, 'audio')
        return
      }

      if (track.kind === 'video') {
        voiceEncryption?.applyReceiverTransform(event.receiver, 'video')

        if (!owner?.user_id || owner.kind !== 'video') {
          return
        }

        const userId = owner.user_id
        const videoStream = new MediaStream([track])

        set((state) => ({
          remoteVideoStreams: { ...state.remoteVideoStreams, [userId]: videoStream },
          participants: state.participants.map((participant) =>
            participant.user_id === userId
              ? { ...participant, video_track_id: track.id }
              : participant
          )
        }))

        track.onended = () => {
          set((state) => {
            const currentStream = state.remoteVideoStreams[userId]
            const currentTrackId = currentStream?.getVideoTracks()[0]?.id ?? null
            if (currentTrackId !== track.id) {
              return {}
            }

            const nextRemoteVideoStreams = { ...state.remoteVideoStreams }
            delete nextRemoteVideoStreams[userId]

            return {
              remoteVideoStreams: nextRemoteVideoStreams,
              participants: state.participants.map((participant) =>
                participant.user_id === userId
                  ? { ...participant, video_track_id: null }
                  : participant
              )
            }
          })
        }
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
        startStatsPolling(set, get)
      } else if (state === 'failed' || state === 'closed') {
        get().disconnect()
      }
    }
  })

  joinVoiceChannel(topic, async (event, payload) => {
    const data = payload as Record<string, unknown>

    if (event === 'offer') {
      try {
        try {
          await webrtcManager!.startAudio(buildVoicePreferences(get()))
        } catch {
          const currentState = get()
          if (currentState.inputDeviceId) {
            localStorage.removeItem(INPUT_DEVICE_KEY)
            set({ inputDeviceId: null })
            await webrtcManager!.startAudio(
              buildVoicePreferences({ ...get(), inputDeviceId: null })
            )
            set({
              errorMessage: 'Your saved microphone was unavailable, so Vesper switched to the default input.'
            })
          } else {
            throw new Error('microphone_unavailable')
          }
        }

        const localStream = webrtcManager!.getLocalStream()
        if (localStream) audioManager?.setLocalStream(localStream)

        for (const sender of webrtcManager!.getSenders()) {
          if (sender.track?.kind === 'audio') {
            voiceEncryption?.applySenderTransform(sender)
          }
        }

        const answerSdp = await webrtcManager!.handleOffer(data.sdp as string)
        pushToChannel(topic, 'answer', { sdp: answerSdp })

        if (data.track_map) {
          const nextTrackMap = parseTrackMap(data.track_map)
          const knownTrackIds = get().trackIdsByMid
          set((state) => {
            const nextRemoteVideoStreams = { ...state.remoteVideoStreams }

            const participants = state.participants.map((participant) => {
              const mappedAudioMid = findMappedMid(nextTrackMap, participant.user_id, 'audio')
              const mappedVideoMid = findMappedMid(nextTrackMap, participant.user_id, 'video')
              const mappedAudioTrackId = mappedAudioMid ? knownTrackIds[mappedAudioMid] : null
              const mappedVideoTrackId = mappedVideoMid ? knownTrackIds[mappedVideoMid] : null

              if (mappedVideoTrackId) {
                const receiverTrack = webrtcManager
                  ?.getReceivers()
                  .find((receiver) => receiver.track.kind === 'video' && receiver.track.id === mappedVideoTrackId)
                  ?.track
                if (receiverTrack) {
                  nextRemoteVideoStreams[participant.user_id] = new MediaStream([receiverTrack])
                }
              } else {
                delete nextRemoteVideoStreams[participant.user_id]
              }

              return {
                ...participant,
                audio_track_id: mappedAudioTrackId ?? participant.audio_track_id ?? null,
                video_track_id: mappedVideoTrackId ?? participant.video_track_id ?? null
              }
            })

            return {
              trackMap: nextTrackMap,
              remoteVideoStreams: nextRemoteVideoStreams,
              participants
            }
          })
        }

        const userId = useAuthStore.getState().user?.id
        audioManager?.onSpeakingChange((levels) => {
          const { participants } = get()
          let changed = false
          const updated = participants.map((p) => {
            let speaking = false
            if (p.user_id === userId) {
              speaking = levels.get('__local__') ?? false
            } else {
              speaking = p.audio_track_id ? levels.get(p.audio_track_id) ?? false : false
            }
            if (p.speaking !== speaking) changed = true
            return changed || p.speaking !== speaking ? { ...p, speaking } : p
          })
          if (changed) set({ participants: updated })
        })

        setupVoiceE2EE(roomId, topic)
      } catch {
        set({
          errorMessage: 'Voice setup failed. Check your permissions and selected devices.'
        })
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
      const previousParticipants = get().participants
      const previousByUserId = new Map(previousParticipants.map((participant) => [participant.user_id, participant]))
      const nextParticipants = (data.participants as VoiceParticipant[]).map((participant) => {
        const previous = previousByUserId.get(participant.user_id)
        return {
          ...participant,
          audio_track_id: previous?.audio_track_id ?? null,
          video_track_id: previous?.video_track_id ?? participant.video_track_id ?? null
        }
      })

      const nextParticipantIds = new Set(nextParticipants.map((participant) => participant.user_id))
      set((state) => ({
        participants: nextParticipants,
        remoteVideoStreams: Object.fromEntries(
          Object.entries(state.remoteVideoStreams).filter(([userId]) => nextParticipantIds.has(userId))
        )
      }))
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
      set({
        state: 'idle',
        roomId: null,
        roomType: null,
        participants: [],
        trackMap: {},
        trackIdsByMid: {},
        videoMode: 'none',
        cameraEnabled: false,
        screenShareEnabled: false,
        localVideoStream: null,
        remoteVideoStreams: {},
        errorMessage: 'Could not join that voice session right now.',
        ...buildResetConnectionStats()
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
