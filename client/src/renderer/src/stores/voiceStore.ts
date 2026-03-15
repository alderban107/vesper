import { create } from 'zustand'
import {
  ackPendingWelcome,
  ackPendingResyncRequest,
  fetchPendingResyncRequests
} from '../api/crypto'
import { getVoiceRtcConfig } from '../api/voiceConfig'
import { connectSocket, joinVoiceChannel, leaveChannel, pushToChannel } from '../api/socket'
import {
  WebRTCManager,
  type VoiceMediaSlot,
  type VideoPublishProfile
} from '../voice/webrtc'
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
const REMOTE_VOICE_VOLUMES_KEY = 'voice:remoteVoiceVolumes'
const REMOTE_STREAM_VOLUMES_KEY = 'voice:remoteStreamVolumes'
const SHARE_AUDIO_PREFERRED_KEY = 'voice:shareAudioPreferred'
const MLS_JOIN_REQUEST_COOLDOWN_MS = 2000
const MLS_RESYNC_REQUEST_COOLDOWN_MS = 5000
const VOICE_MLS_RECOVERY_BACKOFF_MS = [150, 500, 1500] as const

const recentVoiceJoinRequests = new Map<string, number>()
const recentVoiceResyncRequests = new Map<string, number>()
const inFlightVoiceRecoveries = new Map<string, Promise<void>>()

function maybeRequestVoiceMlsJoin(topic: string): void {
  const now = Date.now()
  const lastRequestAt = recentVoiceJoinRequests.get(topic) ?? 0
  if (now - lastRequestAt < MLS_JOIN_REQUEST_COOLDOWN_MS) {
    return
  }

  recentVoiceJoinRequests.set(topic, now)
  pushToChannel(topic, 'mls_request_join', {})
}

interface PendingVoiceMlsResyncRequest {
  id?: string
  requester_id: string
  requester_username?: string | null
  request_id?: string
  last_known_epoch?: number | null
  reason?: string | null
}

function maybeRequestVoiceMlsResync(topic: string, reason: string): void {
  const user = useAuthStore.getState().user
  if (!user) {
    return
  }

  const now = Date.now()
  const lastRequestAt = recentVoiceResyncRequests.get(topic) ?? 0
  if (now - lastRequestAt < MLS_RESYNC_REQUEST_COOLDOWN_MS) {
    return
  }

  recentVoiceResyncRequests.set(topic, now)
  pushToChannel(topic, 'mls_resync_request', {
    request_id: crypto.randomUUID(),
    last_known_epoch: null,
    reason,
    username: user.username
  })
}

async function processVoiceMlsResyncRequest(
  topic: string,
  request: PendingVoiceMlsResyncRequest
): Promise<boolean> {
  const requesterId = request.requester_id
  const requesterUsername = request.requester_username ?? undefined
  const userId = useAuthStore.getState().user?.id
  const cryptoStore = useCryptoStore.getState()

  if (!requesterId || requesterId === userId || !cryptoStore.hasGroup(topic)) {
    return false
  }

  const result = await cryptoStore.handleResyncRequest(topic, requesterId, requesterUsername)
  if (!result) {
    return false
  }

  if (result.removeCommitBytes) {
    pushToChannel(topic, 'mls_remove', {
      removed_user_id: requesterId,
      commit_data: result.removeCommitBytes
    })
  }

  pushToChannel(topic, 'mls_commit', {
    commit_data: result.commitBytes
  })

  if (result.welcomeBytes) {
    pushToChannel(topic, 'mls_welcome', {
      recipient_id: requesterId,
      welcome_data: result.welcomeBytes
    })
  }

  if (request.id) {
    await ackPendingResyncRequest(request.id)
  }

  return true
}

async function processPendingVoiceMlsResyncRequests(topic: string): Promise<void> {
  const requests = await fetchPendingResyncRequests(topic)
  for (const request of requests) {
    await processVoiceMlsResyncRequest(topic, request)
  }
}

async function applyVoiceKeyIfAvailable(topic: string): Promise<boolean> {
  const voiceKey = await useCryptoStore.getState().getVoiceKey(topic)
  if (!voiceKey) {
    return false
  }

  voiceEncryption?.setKey(voiceKey)
  await processPendingVoiceMlsResyncRequests(topic).catch(() => {})
  return true
}

async function ensureVoiceGroupReady(
  topic: string,
  preferredCreatorId?: string
): Promise<void> {
  const crypto = useCryptoStore.getState()
  const userId = useAuthStore.getState().user?.id

  if (!userId) {
    return
  }

  await crypto.ensureGroupMembership(topic)
  if (crypto.hasGroup(topic)) {
    return
  }

  const creatorId = preferredCreatorId ?? userId
  if (creatorId === userId) {
    await crypto.createGroup(topic)
    if (crypto.hasGroup(topic)) {
      pushToChannel(topic, 'mls_request_join_all', {})
      return
    }
  }

  maybeRequestVoiceMlsJoin(topic)
  maybeRequestVoiceMlsResync(topic, 'missing_state')
}

async function recoverVoiceMlsState(
  topic: string,
  reason: string,
  preferredCreatorId?: string
): Promise<void> {
  const existing = inFlightVoiceRecoveries.get(topic)
  if (existing) {
    return existing
  }

  const run = (async () => {
    const crypto = useCryptoStore.getState()

    const tryRecoveryRound = async (roundReason: string): Promise<boolean> => {
      await ensureVoiceGroupReady(topic, preferredCreatorId).catch(() => {})
      maybeRequestVoiceMlsResync(topic, roundReason)

      if (await applyVoiceKeyIfAvailable(topic)) {
        return true
      }

      for (const delayMs of VOICE_MLS_RECOVERY_BACKOFF_MS) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        await ensureVoiceGroupReady(topic, preferredCreatorId).catch(() => {})
        maybeRequestVoiceMlsResync(topic, roundReason)

        if (await applyVoiceKeyIfAvailable(topic)) {
          return true
        }
      }

      return false
    }

    if (await tryRecoveryRound(reason)) {
      return
    }

    if (crypto.hasGroup(topic)) {
      await crypto.resetGroup(topic).catch(() => {})
    }

    await tryRecoveryRound('local_state_reset')
  })().finally(() => {
    inFlightVoiceRecoveries.delete(topic)
  })

  inFlightVoiceRecoveries.set(topic, run)
  return run
}

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

function readVolumeMap(key: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(key)
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
  voice_audio_track_id?: string | null
  share_audio_track_id?: string | null
  camera_video_track_id?: string | null
  share_video_track_id?: string | null
}

export type VoiceConnectionQuality = 'good' | 'fair' | 'poor' | 'unknown'
export type VoiceVideoMode = 'none' | 'camera' | 'screen' | 'camera+screen'

export interface VoiceTrackOwner {
  user_id: string
  kind: 'audio' | 'video'
  slot: VoiceMediaSlot
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
  localCameraStream: MediaStream | null
  localShareStream: MediaStream | null
  remoteVideoStreams: Record<string, MediaStream>
  remoteMediaStreams: Record<string, MediaStream>
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
  remoteStreamVolumes: Record<string, number>
  shareAudioPreferred: boolean
  encryptedMediaSupported: boolean
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
  toggleCamera: (profile?: VideoPublishProfile) => Promise<void>
  toggleScreenShare: (profile?: VideoPublishProfile, includeAudio?: boolean) => Promise<void>
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
  setRemoteStreamVolume: (userId: string, volume: number) => void
  setShareAudioPreferred: (enabled: boolean) => void
}

let webrtcManager: WebRTCManager | null = null
let audioManager: AudioManager | null = null
let voiceEncryption: VoiceEncryption | null = null
let statsPollInterval: ReturnType<typeof setInterval> | null = null

const DEFAULT_CAMERA_PROFILE: VideoPublishProfile = {
  width: 1280,
  height: 720,
  frameRate: 30,
  bitrateKbps: 2500,
  contentHint: 'motion'
}

const DEFAULT_SHARE_PROFILE: VideoPublishProfile = {
  width: 1920,
  height: 1080,
  frameRate: 30,
  bitrateKbps: 4000,
  contentHint: 'detail'
}

function streamKey(userId: string, slot: 'camera_video' | 'share_video'): string {
  return `${userId}:${slot}`
}

function sourceKey(userId: string, slot: 'voice_audio' | 'share_audio'): string {
  return `${userId}:${slot}`
}

function deriveVideoMode(cameraEnabled: boolean, screenShareEnabled: boolean): VoiceVideoMode {
  if (cameraEnabled && screenShareEnabled) {
    return 'camera+screen'
  }

  if (screenShareEnabled) {
    return 'screen'
  }

  if (cameraEnabled) {
    return 'camera'
  }

  return 'none'
}

function toPrimaryVideoStreamMap(
  participants: VoiceParticipant[],
  remoteMediaStreams: Record<string, MediaStream>
): Record<string, MediaStream> {
  return participants.reduce<Record<string, MediaStream>>((acc, participant) => {
    const shareStream = remoteMediaStreams[streamKey(participant.user_id, 'share_video')]
    const cameraStream = remoteMediaStreams[streamKey(participant.user_id, 'camera_video')]
    const primaryStream = shareStream ?? cameraStream

    if (primaryStream) {
      acc[participant.user_id] = primaryStream
    }

    return acc
  }, {})
}

function cleanup(get: () => VoiceState): void {
  const { roomId, roomType } = get()

  if (roomId) {
    const topic = roomType === 'dm' ? `voice:dm:${roomId}` : `voice:channel:${roomId}`
    leaveChannel(topic)
    useCryptoStore.getState().resetGroup(topic).catch(() => {})
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
      parsed[mid] = { user_id: rawEntry, kind: 'audio', slot: 'voice_audio' }
      continue
    }

    if (!rawEntry || typeof rawEntry !== 'object') {
      continue
    }

    const entry = rawEntry as Record<string, unknown>
    const userId = typeof entry.user_id === 'string' ? entry.user_id : null
    const kind = entry.kind === 'video' ? 'video' : 'audio'
    const slot =
      entry.slot === 'share_audio' ||
      entry.slot === 'camera_video' ||
      entry.slot === 'share_video' ||
      entry.slot === 'voice_audio'
        ? entry.slot
        : kind === 'video'
          ? 'camera_video'
          : 'voice_audio'

    if (userId) {
      parsed[mid] = { user_id: userId, kind, slot }
    }
  }

  return parsed
}

function findMappedMid(
  trackMap: Record<string, VoiceTrackOwner>,
  userId: string,
  slot: VoiceMediaSlot
): string | undefined {
  return Object.entries(trackMap).find(([, owner]) => owner.user_id === userId && owner.slot === slot)?.[0]
}

function parsePublishMap(rawPublishMap: unknown): Partial<Record<VoiceMediaSlot, string>> {
  if (!rawPublishMap || typeof rawPublishMap !== 'object') {
    return {}
  }

  const parsed: Partial<Record<VoiceMediaSlot, string>> = {}

  for (const slot of ['voice_audio', 'share_audio', 'camera_video', 'share_video'] as const) {
    const mid = (rawPublishMap as Record<string, unknown>)[slot]
    if (typeof mid === 'string' && mid.length > 0) {
      parsed[slot] = mid
    }
  }

  return parsed
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

function ensureTrustedVoiceDevice(
  set: (partial: Partial<VoiceState>) => void
): boolean {
  if (useAuthStore.getState().canUseE2EE) {
    return true
  }

  set({
    state: 'idle',
    errorMessage: 'Approve this device to join encrypted calls.'
  })
  return false
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
  localCameraStream: null,
  localShareStream: null,
  remoteVideoStreams: {},
  remoteMediaStreams: {},
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
  remoteVolumes: readVolumeMap(REMOTE_VOICE_VOLUMES_KEY),
  remoteStreamVolumes: readVolumeMap(REMOTE_STREAM_VOLUMES_KEY),
  shareAudioPreferred: readBoolean(SHARE_AUDIO_PREFERRED_KEY, true),
  encryptedMediaSupported: WebRTCManager.supportsEncryptedMedia(),
  ...buildResetConnectionStats(),

  joinVoiceChannel: async (channelId) => {
    if (!ensureTrustedVoiceDevice(set)) {
      return
    }

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
      localCameraStream: null,
      localShareStream: null,
      remoteMediaStreams: {},
      errorMessage: null,
      ...buildResetConnectionStats()
    })

    connectSocket()
    await initVoice(channelId, 'channel', set, get)
  },

  startDmCall: async (conversationId) => {
    if (!ensureTrustedVoiceDevice(set)) {
      return
    }

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
      localCameraStream: null,
      localShareStream: null,
      remoteMediaStreams: {},
      errorMessage: null,
      ...buildResetConnectionStats()
    })

    connectSocket()
    await initVoice(conversationId, 'dm', set, get)

    // After joining, send call_ring
    const topic = `voice:dm:${conversationId}`
    pushToChannel(topic, 'call_ring', {})
    set({ state: 'ringing' })
  },

  acceptCall: async (conversationId) => {
    if (!ensureTrustedVoiceDevice(set)) {
      return
    }

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
      localCameraStream: null,
      localShareStream: null,
      remoteMediaStreams: {},
      errorMessage: null,
      ...buildResetConnectionStats()
    })

    connectSocket()
    await initVoice(conversationId, 'dm', set, get)

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
      localCameraStream: null,
      localShareStream: null,
      remoteMediaStreams: {},
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

  toggleCamera: async (profile = DEFAULT_CAMERA_PROFILE) => {
    const currentState = get()
    const { state, cameraEnabled, screenShareEnabled } = currentState
    if (state !== 'connected' && state !== 'in_call') {
      return
    }

    if (!currentState.encryptedMediaSupported) {
      set({
        errorMessage: 'Encrypted camera streaming requires a Chromium-class browser or the desktop app.'
      })
      return
    }

    if (!webrtcManager) {
      return
    }

    if (cameraEnabled) {
      await webrtcManager.stopCamera().catch(() => {})
      set({
        cameraEnabled: false,
        localCameraStream: null,
        localVideoStream: currentState.localShareStream,
        videoMode: deriveVideoMode(false, screenShareEnabled)
      })
      return
    }

    try {
      const localCameraStream = await webrtcManager.startCamera(profile)
      const localTrack = localCameraStream.getVideoTracks()[0] ?? null
      if (localTrack) {
        localTrack.onended = () => {
          if (get().cameraEnabled) {
            void get().toggleCamera(profile)
          }
        }
      }

      for (const sender of webrtcManager.getSenders()) {
        if (sender.track?.kind === 'video') {
          voiceEncryption?.applySenderTransform(sender, 'video')
        }
      }

      set({
        cameraEnabled: true,
        localCameraStream,
        localVideoStream: get().localShareStream ?? localCameraStream,
        videoMode: deriveVideoMode(true, screenShareEnabled),
        errorMessage: null
      })
    } catch {
      set({
        errorMessage: 'Could not start camera. Check camera permissions and try again.'
      })
    }
  },

  toggleScreenShare: async (profile = DEFAULT_SHARE_PROFILE, includeAudio) => {
    const currentState = get()
    const { state, cameraEnabled, screenShareEnabled } = currentState
    const shareAudioEnabled = includeAudio ?? currentState.shareAudioPreferred
    if (state !== 'connected' && state !== 'in_call') {
      return
    }

    if (!currentState.encryptedMediaSupported) {
      set({
        errorMessage: 'Encrypted screen sharing requires a Chromium-class browser or the desktop app.'
      })
      return
    }

    if (!webrtcManager) {
      return
    }

    if (screenShareEnabled) {
      await webrtcManager.stopScreenShare().catch(() => {})
      set({
        screenShareEnabled: false,
        localShareStream: null,
        localVideoStream: get().localCameraStream,
        videoMode: deriveVideoMode(cameraEnabled, false)
      })
      return
    }

    try {
      const localShareStream = await webrtcManager.startScreenShare(profile, shareAudioEnabled)
      const shareTrack = localShareStream.getVideoTracks()[0] ?? null
      if (shareTrack) {
        shareTrack.onended = () => {
          if (get().screenShareEnabled) {
            void get().toggleScreenShare(profile, shareAudioEnabled)
          }
        }
      }

      for (const sender of webrtcManager.getSenders()) {
        if (sender.track?.kind === 'video') {
          voiceEncryption?.applySenderTransform(sender, 'video')
        } else if (sender.track?.kind === 'audio') {
          voiceEncryption?.applySenderTransform(sender, 'audio')
        }
      }

      set({
        screenShareEnabled: true,
        localShareStream,
        localVideoStream: localShareStream,
        videoMode: deriveVideoMode(cameraEnabled, true),
        errorMessage: null
      })
    } catch {
      set({
        errorMessage: 'Could not start screen share. Check screen capture permissions and try again.'
      })
    }
  },

  stopVideoShare: async () => {
    const currentState = get()

    if (currentState.cameraEnabled) {
      await webrtcManager?.stopCamera().catch(() => {})
    }

    if (currentState.screenShareEnabled) {
      await webrtcManager?.stopScreenShare().catch(() => {})
    }

    set({
      videoMode: 'none',
      cameraEnabled: false,
      screenShareEnabled: false,
      localVideoStream: null,
      localCameraStream: null,
      localShareStream: null
    })
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
      localStorage.setItem(REMOTE_VOICE_VOLUMES_KEY, JSON.stringify(remoteVolumes))
      audioManager?.setSourceVolume(sourceKey(userId, 'voice_audio'), nextVolume)

      return { remoteVolumes }
    })
  },

  setRemoteStreamVolume: (userId, volume) => {
    const nextVolume = Math.max(0, Math.min(200, volume))
    set((state) => {
      const remoteStreamVolumes = { ...state.remoteStreamVolumes, [userId]: nextVolume }
      localStorage.setItem(REMOTE_STREAM_VOLUMES_KEY, JSON.stringify(remoteStreamVolumes))
      audioManager?.setSourceVolume(sourceKey(userId, 'share_audio'), nextVolume)

      return { remoteStreamVolumes }
    })
  },

  setShareAudioPreferred: (enabled) => {
    localStorage.setItem(SHARE_AUDIO_PREFERRED_KEY, String(enabled))
    set({ shareAudioPreferred: enabled })
  }
}))

async function initVoice(
  roomId: string,
  roomType: 'channel' | 'dm',
  set: (partial: Partial<VoiceState> | ((state: VoiceState) => Partial<VoiceState>)) => void,
  get: () => VoiceState
): Promise<void> {
  webrtcManager = new WebRTCManager()
  audioManager = new AudioManager()
  voiceEncryption = new VoiceEncryption()
  voiceEncryption.init()
  audioManager.setOutputVolume(get().outputVolume)
  audioManager.setSpeakingSensitivity(get().inputSensitivity)

  const topic = roomType === 'dm' ? `voice:dm:${roomId}` : `voice:channel:${roomId}`
  const rtcConfig = await getVoiceRtcConfig(true)

  webrtcManager.init(rtcConfig.iceServers, rtcConfig.iceTransportPolicy, {
    onTrack: (event) => {
      const track = event.track
      const mid = event.transceiver?.mid ?? null
      const owner = mid ? get().trackMap[mid] : undefined

      if (mid) {
        set((state) => ({ trackIdsByMid: { ...state.trackIdsByMid, [mid]: track.id } }))
      }

      if (track.kind === 'audio') {
        if (owner?.user_id && owner.kind === 'audio') {
          const volumeSource = sourceKey(owner.user_id, owner.slot === 'share_audio' ? 'share_audio' : 'voice_audio')
          const storedVolume =
            owner.slot === 'share_audio'
              ? get().remoteStreamVolumes[owner.user_id]
              : get().remoteVolumes[owner.user_id]
          const previousTrackId = get().participants.find((participant) => participant.user_id === owner.user_id)
            ?.[owner.slot === 'share_audio' ? 'share_audio_track_id' : 'voice_audio_track_id']

          if (previousTrackId && previousTrackId !== track.id) {
            audioManager?.removeRemoteTrack(previousTrackId)
          }

          audioManager?.addRemoteTrack(track.id, track, volumeSource)
          if (storedVolume !== undefined) {
            audioManager?.setSourceVolume(volumeSource, storedVolume)
          }

          set((state) => ({
            participants: state.participants.map((participant) => {
              if (participant.user_id !== owner.user_id) {
                return participant
              }

              if (owner.slot === 'share_audio') {
                return { ...participant, share_audio_track_id: track.id }
              }

              return {
                ...participant,
                audio_track_id: track.id,
                voice_audio_track_id: track.id
              }
            })
          }))

          track.onended = () => {
            audioManager?.removeRemoteTrack(track.id)

            set((state) => ({
              participants: state.participants.map((participant) => {
                if (participant.user_id !== owner.user_id) {
                  return participant
                }

                if (owner.slot === 'share_audio') {
                  if (participant.share_audio_track_id !== track.id) {
                    return participant
                  }

                  return { ...participant, share_audio_track_id: null }
                }

                if (participant.voice_audio_track_id !== track.id && participant.audio_track_id !== track.id) {
                  return participant
                }

                return {
                  ...participant,
                  audio_track_id: participant.audio_track_id === track.id ? null : participant.audio_track_id,
                  voice_audio_track_id:
                    participant.voice_audio_track_id === track.id ? null : participant.voice_audio_track_id
                }
              })
            }))
          }
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
        const slot = owner.slot === 'share_video' ? 'share_video' : 'camera_video'
        const key = streamKey(userId, slot)
        const videoStream = new MediaStream([track])

        set((state) => {
          const remoteMediaStreams = { ...state.remoteMediaStreams, [key]: videoStream }
          const participants = state.participants.map((participant) => {
            if (participant.user_id !== userId) {
              return participant
            }

            const nextParticipant = slot === 'share_video'
              ? { ...participant, share_video_track_id: track.id }
              : { ...participant, camera_video_track_id: track.id }

            return {
              ...nextParticipant,
              video_track_id: nextParticipant.share_video_track_id ?? nextParticipant.camera_video_track_id ?? null
            }
          })

          return {
            remoteMediaStreams,
            remoteVideoStreams: toPrimaryVideoStreamMap(participants, remoteMediaStreams),
            participants
          }
        })

        track.onended = () => {
          set((state) => {
            const nextRemoteMediaStreams = { ...state.remoteMediaStreams }
            delete nextRemoteMediaStreams[key]

            const participants = state.participants.map((participant) => {
              if (participant.user_id !== userId) {
                return participant
              }

              const nextParticipant = slot === 'share_video'
                ? { ...participant, share_video_track_id: null }
                : { ...participant, camera_video_track_id: null }

              return {
                ...nextParticipant,
                video_track_id: nextParticipant.share_video_track_id ?? nextParticipant.camera_video_track_id ?? null
              }
            })

            return {
              remoteMediaStreams: nextRemoteMediaStreams,
              remoteVideoStreams: toPrimaryVideoStreamMap(participants, nextRemoteMediaStreams),
              participants
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
        const nextTrackMap = data.track_map ? parseTrackMap(data.track_map) : {}
        if (Object.keys(nextTrackMap).length > 0) {
          set({ trackMap: nextTrackMap })
        }

        await webrtcManager!.prepareOffer(
          data.sdp as string,
          parsePublishMap(data.publish_map)
        )

        try {
          if (webrtcManager!.getLocalStream()) {
            await webrtcManager!.rebindLocalTracks()
          } else {
            await webrtcManager!.startAudio(buildVoicePreferences(get()))
          }
        } catch {
          const currentState = get()
          if (currentState.inputDeviceId) {
            localStorage.removeItem(INPUT_DEVICE_KEY)
            set({ inputDeviceId: null })
            if (webrtcManager!.getLocalStream()) {
              await webrtcManager!.updateAudioInput(
                buildVoicePreferences({ ...get(), inputDeviceId: null })
              )
            } else {
              await webrtcManager!.startAudio(
                buildVoicePreferences({ ...get(), inputDeviceId: null })
              )
            }
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
          } else if (sender.track?.kind === 'video') {
            voiceEncryption?.applySenderTransform(sender, 'video')
          }
        }

        const answerSdp = await webrtcManager!.finalizeAnswer()
        pushToChannel(topic, 'answer', { sdp: answerSdp })

        if (Object.keys(nextTrackMap).length > 0) {
          const knownTrackIds = get().trackIdsByMid
          set((state) => {
            const nextRemoteMediaStreams = { ...state.remoteMediaStreams }

            const participants = state.participants.map((participant) => {
              const voiceAudioTrackId = (() => {
                const mappedMid = findMappedMid(nextTrackMap, participant.user_id, 'voice_audio')
                return mappedMid ? knownTrackIds[mappedMid] ?? null : participant.voice_audio_track_id ?? null
              })()

              const shareAudioTrackId = (() => {
                const mappedMid = findMappedMid(nextTrackMap, participant.user_id, 'share_audio')
                return mappedMid ? knownTrackIds[mappedMid] ?? null : participant.share_audio_track_id ?? null
              })()

              const cameraVideoTrackId = (() => {
                const mappedMid = findMappedMid(nextTrackMap, participant.user_id, 'camera_video')
                return mappedMid ? knownTrackIds[mappedMid] ?? null : participant.camera_video_track_id ?? null
              })()

              const shareVideoTrackId = (() => {
                const mappedMid = findMappedMid(nextTrackMap, participant.user_id, 'share_video')
                return mappedMid ? knownTrackIds[mappedMid] ?? null : participant.share_video_track_id ?? null
              })()

              for (const [slot, trackId] of [
                ['camera_video', cameraVideoTrackId],
                ['share_video', shareVideoTrackId]
              ] as const) {
                const key = streamKey(participant.user_id, slot)
                if (trackId) {
                  const receiverTrack = webrtcManager
                    ?.getReceivers()
                    .find((receiver) => receiver.track.kind === 'video' && receiver.track.id === trackId)
                    ?.track
                  if (receiverTrack) {
                    nextRemoteMediaStreams[key] = new MediaStream([receiverTrack])
                  }
                } else {
                  delete nextRemoteMediaStreams[key]
                }
              }

              return {
                ...participant,
                audio_track_id: voiceAudioTrackId,
                voice_audio_track_id: voiceAudioTrackId,
                share_audio_track_id: shareAudioTrackId,
                camera_video_track_id: cameraVideoTrackId,
                share_video_track_id: shareVideoTrackId,
                video_track_id: shareVideoTrackId ?? cameraVideoTrackId
              }
            })

            return {
              trackMap: nextTrackMap,
              remoteMediaStreams: nextRemoteMediaStreams,
              remoteVideoStreams: toPrimaryVideoStreamMap(participants, nextRemoteMediaStreams),
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
              speaking = p.voice_audio_track_id ? levels.get(p.voice_audio_track_id) ?? false : false
            }
            if (p.speaking !== speaking) changed = true
            return changed || p.speaking !== speaking ? { ...p, speaking } : p
          })
          if (changed) set({ participants: updated })
        })

        const preferredCreatorId =
          typeof data.e2ee_creator_id === 'string' ? data.e2ee_creator_id : undefined

        void setupVoiceE2EE(topic, preferredCreatorId).catch(() => {
          set({
            errorMessage: 'Voice encryption setup failed. Rejoin the call to try again.'
          })
          get().disconnect()
        })
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
          audio_track_id: participant.voice_audio_track_id ?? previous?.audio_track_id ?? null,
          voice_audio_track_id: participant.voice_audio_track_id ?? previous?.voice_audio_track_id ?? null,
          share_audio_track_id: participant.share_audio_track_id ?? previous?.share_audio_track_id ?? null,
          camera_video_track_id: participant.camera_video_track_id ?? previous?.camera_video_track_id ?? null,
          share_video_track_id: participant.share_video_track_id ?? previous?.share_video_track_id ?? null,
          video_track_id:
            participant.share_video_track_id ??
            participant.camera_video_track_id ??
            previous?.video_track_id ??
            null
        }
      })

      const nextParticipantIds = new Set(nextParticipants.map((participant) => participant.user_id))
      const nextStreamKeys = new Set(
        nextParticipants.flatMap((participant) => {
          const keys: string[] = []

          if (participant.camera_video_track_id) {
            keys.push(streamKey(participant.user_id, 'camera_video'))
          }

          if (participant.share_video_track_id) {
            keys.push(streamKey(participant.user_id, 'share_video'))
          }

          return keys
        })
      )
      const nextRemoteMediaStreams = Object.fromEntries(
        Object.entries(get().remoteMediaStreams).filter(([key]) => {
          const [userId] = key.split(':')
          return nextParticipantIds.has(userId) && nextStreamKeys.has(key)
        })
      )

      set((state) => ({
        participants: nextParticipants,
        remoteMediaStreams: nextRemoteMediaStreams,
        remoteVideoStreams: toPrimaryVideoStreamMap(nextParticipants, nextRemoteMediaStreams)
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
    } else if (event === 'mls_request_join_all') {
      if (!useCryptoStore.getState().hasGroup(topic)) {
        void recoverVoiceMlsState(topic, 'missing_state', preferredCreatorId).catch(() => {})
      }
    } else if (event === 'mls_request_join') {
      handleVoiceMlsJoinRequest(roomId, data, topic)
    } else if (event === 'mls_resync_request') {
      await processVoiceMlsResyncRequest(topic, {
        id: data.id as string | undefined,
        requester_id: data.user_id as string,
        requester_username: (data.username as string | undefined) ?? undefined,
        request_id: data.request_id as string | undefined,
        last_known_epoch: (data.last_known_epoch as number | null | undefined) ?? null,
        reason: (data.reason as string | null | undefined) ?? null
      })
    } else if (event === 'mls_commit') {
      const senderId = data.sender_id as string
      const userId = useAuthStore.getState().user?.id
      if (senderId !== userId) {
        const crypto = useCryptoStore.getState()
        await crypto.handleCommit(topic, data.commit_data as string)
        if (!(await applyVoiceKeyIfAvailable(topic))) {
          void recoverVoiceMlsState(topic, 'voice_key_missing', preferredCreatorId).catch(() => {})
        }
      }
    } else if (event === 'mls_welcome') {
      const recipientId = data.recipient_id as string
      const userId = useAuthStore.getState().user?.id
      if (recipientId === userId) {
        const crypto = useCryptoStore.getState()
        const welcomeId = typeof data.id === 'string' ? data.id : null
        const processed = await crypto.handleWelcome(topic, data.welcome_data as string)
        if (processed) {
          if (welcomeId) {
            await ackPendingWelcome(welcomeId).catch(() => {})
          }
          if (!(await applyVoiceKeyIfAvailable(topic))) {
            void recoverVoiceMlsState(topic, 'voice_key_missing', preferredCreatorId).catch(() => {})
          }
        }
      }
    } else if (event === 'mls_remove') {
      const userId = useAuthStore.getState().user?.id
      const removedId = data.removed_user_id as string
      if (removedId === userId) {
        await useCryptoStore.getState().resetGroup(topic)
        void recoverVoiceMlsState(topic, 'removed_from_group', preferredCreatorId).catch(() => {})
      } else if (data.commit_data) {
        const crypto = useCryptoStore.getState()
        await crypto.handleCommit(topic, data.commit_data as string)
        if (!(await applyVoiceKeyIfAvailable(topic))) {
          void recoverVoiceMlsState(topic, 'voice_key_missing', preferredCreatorId).catch(() => {})
        }
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
        localCameraStream: null,
        localShareStream: null,
        remoteMediaStreams: {},
        errorMessage: 'Could not join that voice session right now.',
        ...buildResetConnectionStats()
      })
    }
  })
}

async function setupVoiceE2EE(
  topic: string,
  preferredCreatorId?: string
): Promise<void> {
  if (!useAuthStore.getState().canUseE2EE) {
    return
  }

  await ensureVoiceGroupReady(topic, preferredCreatorId)

  if (await applyVoiceKeyIfAvailable(topic)) {
    return
  }

  await recoverVoiceMlsState(topic, 'voice_key_missing', preferredCreatorId)
}

async function handleVoiceMlsJoinRequest(
  _roomId: string,
  msg: Record<string, unknown>,
  topic: string
): Promise<void> {
  const userId = msg.user_id as string
  const username = (msg.username as string | undefined) ?? undefined
  const crypto = useCryptoStore.getState()

  if (!crypto.hasGroup(topic)) return

  const result = await crypto.handleJoinRequest(topic, userId, username)

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
  const newKey = await crypto.getVoiceKey(topic)
  if (newKey) voiceEncryption?.setKey(newKey)
}
