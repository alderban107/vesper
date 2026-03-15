import type { VoicePreferences } from '../stores/voiceStore'

export interface VoiceConnectionStats {
  roundTripMs: number | null
  packetLossPct: number | null
  jitterMs: number | null
  inboundBitrateKbps: number | null
  outboundBitrateKbps: number | null
}

interface BitrateSample {
  bytes: number
  timestampMs: number
}

export type LocalVideoMode = 'camera' | 'screen'
export type VoiceMediaSlot = 'voice_audio' | 'share_audio' | 'camera_video' | 'share_video'
type LocalVisualSlot = 'camera_video' | 'share_video'

export interface VideoPublishProfile {
  width: number
  height: number
  frameRate: number
  bitrateKbps: number
  contentHint: 'motion' | 'detail' | 'text'
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop()
  }
}

export class WebRTCManager {
  private static readonly NOISE_GATE_FLOOR_RMS = 0.00001
  private static readonly NOISE_GATE_INTERVAL_MS = 50
  private static readonly NOISE_GATE_HOLD_MS = 180
  private static readonly NOISE_GATE_OPEN_RAMP_SECONDS = 0.008
  private static readonly NOISE_GATE_CLOSE_RAMP_SECONDS = 0.035

  private pc: RTCPeerConnection | null = null
  private localStream: MediaStream | null = null
  private rawLocalStream: MediaStream | null = null
  private localVideoSourceStreams: Partial<Record<LocalVisualSlot, MediaStream>> = {}
  private localVideoPreviewStreams: Partial<Record<LocalVisualSlot, MediaStream>> = {}
  private localShareAudioTrack: MediaStreamTrack | null = null
  private publishMidBySlot: Partial<Record<VoiceMediaSlot, string>> = {}
  private currentCameraProfile: VideoPublishProfile | null = null
  private currentShareProfile: VideoPublishProfile | null = null
  private shareAudioRequested = false
  private audioContext: AudioContext | null = null
  private inputSourceNode: MediaStreamAudioSourceNode | null = null
  private inputGainNode: GainNode | null = null
  private gateGainNode: GainNode | null = null
  private gateAnalyserNode: AnalyserNode | null = null
  private inputDestinationNode: MediaStreamAudioDestinationNode | null = null
  private gateAnalyserBuffer: Uint8Array | null = null
  private gatePollIntervalId: number | null = null
  private gateOpenUntilMs = 0
  private gateIsOpen = true
  private noiseGateEnabled = true
  private noiseGateThresholdDb = -52
  private onTrack: ((event: RTCTrackEvent) => void) | null = null
  private onIceCandidate: ((candidate: RTCIceCandidate) => void) | null = null
  private onConnectionStateChange: ((state: RTCPeerConnectionState) => void) | null = null
  private previousInboundBitrateSamples = new Map<string, BitrateSample>()
  private previousOutboundBitrateSamples = new Map<string, BitrateSample>()

  static supportsEncryptedMedia(): boolean {
    return typeof window !== 'undefined' && 'RTCRtpScriptTransform' in window
  }

  init(
    iceServers: RTCIceServer[],
    handlers: {
      onTrack: (event: RTCTrackEvent) => void
      onIceCandidate: (candidate: RTCIceCandidate) => void
      onConnectionStateChange: (state: RTCPeerConnectionState) => void
    }
  ): void {
    this.onTrack = handlers.onTrack
    this.onIceCandidate = handlers.onIceCandidate
    this.onConnectionStateChange = handlers.onConnectionStateChange

    this.pc = new RTCPeerConnection({ iceServers })

    this.pc.ontrack = (event) => {
      this.onTrack?.(event)
    }

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.onIceCandidate?.(event.candidate)
      }
    }

    this.pc.onconnectionstatechange = () => {
      if (this.pc) {
        this.onConnectionStateChange?.(this.pc.connectionState)
      }
    }
  }

  async startAudio(preferences: VoicePreferences): Promise<void> {
    await this.attachAudio(preferences)
    const audioTrack = this.localStream?.getAudioTracks()[0]
    if (audioTrack) {
      await this.attachTrackToSlot('voice_audio', audioTrack)
    }
  }

  async updateAudioInput(preferences: VoicePreferences): Promise<void> {
    if (!this.pc) {
      return
    }

    const previousTrack = this.localStream?.getAudioTracks()[0] ?? null
    await this.attachAudio(preferences)
    const nextTrack = this.localStream?.getAudioTracks()[0] ?? null

    if (!nextTrack) {
      return
    }

    await this.attachTrackToSlot('voice_audio', nextTrack)

    previousTrack?.stop()
  }

  setPublishMap(publishMap: Partial<Record<VoiceMediaSlot, string>>): void {
    this.publishMidBySlot = publishMap
  }

  async prepareOffer(
    sdp: string,
    publishMap: Partial<Record<VoiceMediaSlot, string>>
  ): Promise<void> {
    if (!this.pc) {
      throw new Error('PeerConnection not initialized')
    }

    await this.pc.setRemoteDescription({ type: 'offer', sdp })
    this.setPublishMap(publishMap)
  }

  async finalizeAnswer(): Promise<string> {
    if (!this.pc) {
      throw new Error('PeerConnection not initialized')
    }

    const answer = await this.pc.createAnswer()
    await this.pc.setLocalDescription(answer)
    return answer.sdp!
  }

  async startVideo(
    mode: LocalVideoMode,
    profile: VideoPublishProfile,
    includeAudio = false
  ): Promise<MediaStream> {
    if (!this.pc) {
      throw new Error('PeerConnection not initialized')
    }

    if (mode === 'screen') {
      return this.startScreenShare(profile, includeAudio)
    }

    return this.startCamera(profile)
  }

  async startCamera(profile: VideoPublishProfile): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: profile.width },
        height: { ideal: profile.height },
        frameRate: { ideal: profile.frameRate, max: profile.frameRate }
      },
      audio: false
    })

    await this.stopCamera()

    const nextTrack = stream.getVideoTracks()[0]
    if (!nextTrack) {
      stopStream(stream)
      throw new Error('No camera track available')
    }

    this.currentCameraProfile = profile
    this.localVideoSourceStreams.camera_video = stream
    this.localVideoPreviewStreams.camera_video = new MediaStream([nextTrack])
    await this.attachTrackToSlot('camera_video', nextTrack)
    await this.applyVideoProfile('camera_video', nextTrack, profile)

    return this.localVideoPreviewStreams.camera_video
  }

  async startScreenShare(
    profile: VideoPublishProfile,
    includeAudio: boolean
  ): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: profile.width },
        height: { ideal: profile.height },
        frameRate: { ideal: profile.frameRate, max: profile.frameRate }
      },
      audio: includeAudio
    })

    await this.stopScreenShare()

    const videoTrack = stream.getVideoTracks()[0]
    if (!videoTrack) {
      stopStream(stream)
      throw new Error('No screen track available')
    }

    this.currentShareProfile = profile
    this.shareAudioRequested = includeAudio
    this.localVideoSourceStreams.share_video = stream
    this.localVideoPreviewStreams.share_video = new MediaStream([videoTrack])
    await this.attachTrackToSlot('share_video', videoTrack)
    await this.applyVideoProfile('share_video', videoTrack, profile)

    const audioTrack = stream.getAudioTracks()[0] ?? null
    this.localShareAudioTrack = audioTrack
    if (audioTrack) {
      await this.attachTrackToSlot('share_audio', audioTrack)
    } else {
      await this.attachTrackToSlot('share_audio', null)
    }

    return this.localVideoPreviewStreams.share_video
  }

  async rebindLocalTracks(): Promise<void> {
    const voiceTrack = this.localStream?.getAudioTracks()[0] ?? null
    await this.attachTrackToSlot('voice_audio', voiceTrack)

    const cameraTrack = this.localVideoSourceStreams.camera_video?.getVideoTracks()[0] ?? null
    await this.attachTrackToSlot('camera_video', cameraTrack)
    if (cameraTrack && this.currentCameraProfile) {
      await this.applyVideoProfile('camera_video', cameraTrack, this.currentCameraProfile)
    }

    const shareTrack = this.localVideoSourceStreams.share_video?.getVideoTracks()[0] ?? null
    await this.attachTrackToSlot('share_video', shareTrack)
    if (shareTrack && this.currentShareProfile) {
      await this.applyVideoProfile('share_video', shareTrack, this.currentShareProfile)
    }

    await this.attachTrackToSlot('share_audio', this.localShareAudioTrack)
  }

  async stopVideo(): Promise<void> {
    await Promise.all([this.stopCamera(), this.stopScreenShare()])
  }

  async stopCamera(): Promise<void> {
    await this.attachTrackToSlot('camera_video', null)
    this.currentCameraProfile = null
    this.cleanupLocalVideoCapture('camera_video')
  }

  async stopScreenShare(): Promise<void> {
    await this.attachTrackToSlot('share_video', null)
    await this.attachTrackToSlot('share_audio', null)
    this.currentShareProfile = null
    this.shareAudioRequested = false
    this.localShareAudioTrack = null
    this.cleanupLocalVideoCapture('share_video')
  }

  getLocalVideoStream(slot: LocalVisualSlot): MediaStream | null {
    return this.localVideoPreviewStreams[slot] ?? null
  }

  hasPublishSlot(slot: VoiceMediaSlot): boolean {
    return this.findSenderBySlot(slot) !== null
  }

  setInputVolume(volume: number): void {
    if (this.inputGainNode) {
      this.inputGainNode.gain.value = Math.max(0, volume) / 100
    }
  }

  setNoiseGateEnabled(enabled: boolean): void {
    this.noiseGateEnabled = enabled

    if (!enabled) {
      this.gateOpenUntilMs = 0
      this.setGateOpen(true)
      return
    }

    this.gateOpenUntilMs = performance.now() + WebRTCManager.NOISE_GATE_HOLD_MS
    this.updateNoiseGate()
  }

  setNoiseGateThresholdDb(thresholdDb: number): void {
    this.noiseGateThresholdDb = Math.max(-80, Math.min(-20, thresholdDb))
    this.updateNoiseGate()
  }

  private async attachAudio(preferences: VoicePreferences): Promise<void> {
    this.cleanupLocalAudioGraph()

    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: preferences.deviceId ? { exact: preferences.deviceId } : undefined,
        echoCancellation: preferences.echoCancellation,
        noiseSuppression: preferences.noiseSuppression,
        autoGainControl: preferences.autoGainControl
      }
    }

    this.rawLocalStream = await navigator.mediaDevices.getUserMedia(constraints)
    const rawTrack = this.rawLocalStream.getAudioTracks()[0]

    if (!rawTrack) {
      throw new Error('No microphone track available')
    }

    this.audioContext = new AudioContext()
    this.noiseGateEnabled = preferences.noiseGateEnabled
    this.noiseGateThresholdDb = Math.max(-80, Math.min(-20, preferences.noiseGateThresholdDb))
    this.inputSourceNode = this.audioContext.createMediaStreamSource(this.rawLocalStream)
    this.inputGainNode = this.audioContext.createGain()
    this.inputGainNode.gain.value = Math.max(0, preferences.inputVolume) / 100
    this.gateGainNode = this.audioContext.createGain()
    this.gateGainNode.gain.value = 1
    this.gateAnalyserNode = this.audioContext.createAnalyser()
    this.gateAnalyserNode.fftSize = 1024
    this.gateAnalyserNode.smoothingTimeConstant = 0.15
    this.gateAnalyserBuffer = new Uint8Array(this.gateAnalyserNode.fftSize)
    this.inputDestinationNode = this.audioContext.createMediaStreamDestination()

    this.inputSourceNode.connect(this.inputGainNode)
    this.inputGainNode.connect(this.gateGainNode)
    this.inputGainNode.connect(this.gateAnalyserNode)
    this.gateGainNode.connect(this.inputDestinationNode)

    this.gateIsOpen = true
    this.gateOpenUntilMs = performance.now() + WebRTCManager.NOISE_GATE_HOLD_MS
    this.startNoiseGateLoop()
    this.localStream = this.inputDestinationNode.stream
  }

  async handleOffer(sdp: string): Promise<string> {
    if (!this.pc) throw new Error('PeerConnection not initialized')

    await this.prepareOffer(sdp, this.publishMidBySlot)
    return this.finalizeAnswer()
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.pc) return
    await this.pc.addIceCandidate(candidate)
  }

  setMuted(muted: boolean): void {
    if (!this.localStream) return
    for (const track of this.localStream.getAudioTracks()) {
      track.enabled = !muted
    }
  }

  getSenders(): RTCRtpSender[] {
    return this.pc?.getSenders() ?? []
  }

  getReceivers(): RTCRtpReceiver[] {
    return this.pc?.getReceivers() ?? []
  }

  getLocalStream(): MediaStream | null {
    return this.localStream
  }

  async getConnectionStats(): Promise<VoiceConnectionStats | null> {
    if (!this.pc) {
      return null
    }

    const report = await this.pc.getStats()
    let roundTripMs: number | null = null
    let jitterMs: number | null = null
    let packetsLost = 0
    let packetsReceived = 0
    let inboundBitrateBitsPerSecond = 0
    let outboundBitrateBitsPerSecond = 0
    const nextInboundBitrateSamples = new Map<string, BitrateSample>()
    const nextOutboundBitrateSamples = new Map<string, BitrateSample>()

    report.forEach((rawStat) => {
      const stat = rawStat as RTCStats & Record<string, unknown>

      if (stat.type === 'candidate-pair') {
        const nominated = Boolean(stat.nominated)
        const selected = Boolean(stat.selected)
        const state = String(stat.state ?? '')
        if ((nominated || selected || state === 'succeeded') && typeof stat.currentRoundTripTime === 'number') {
          roundTripMs = Math.round((stat.currentRoundTripTime as number) * 1000)
        }
      }

      if (stat.type === 'inbound-rtp' && (stat.kind === 'audio' || stat.kind === 'video')) {
        if (typeof stat.packetsLost === 'number') {
          packetsLost += stat.packetsLost
        }
        if (typeof stat.packetsReceived === 'number') {
          packetsReceived += stat.packetsReceived
        }
        if (typeof stat.jitter === 'number') {
          const nextJitterMs = Math.round(stat.jitter * 1000)
          jitterMs = jitterMs === null ? nextJitterMs : Math.max(jitterMs, nextJitterMs)
        }

        const inboundBitrateSample = this.buildBitrateSample(stat)
        if (inboundBitrateSample) {
          nextInboundBitrateSamples.set(stat.id, inboundBitrateSample)
          const previousSample = this.previousInboundBitrateSamples.get(stat.id)
          const bitrateBitsPerSecond = this.computeBitrateBitsPerSecond(previousSample, inboundBitrateSample)
          if (bitrateBitsPerSecond !== null) {
            inboundBitrateBitsPerSecond += bitrateBitsPerSecond
          }
        }
      }

      if (stat.type === 'outbound-rtp' && (stat.kind === 'audio' || stat.kind === 'video')) {
        const outboundBitrateSample = this.buildBitrateSample(stat)
        if (outboundBitrateSample) {
          nextOutboundBitrateSamples.set(stat.id, outboundBitrateSample)
          const previousSample = this.previousOutboundBitrateSamples.get(stat.id)
          const bitrateBitsPerSecond = this.computeBitrateBitsPerSecond(previousSample, outboundBitrateSample)
          if (bitrateBitsPerSecond !== null) {
            outboundBitrateBitsPerSecond += bitrateBitsPerSecond
          }
        }
      }
    })

    this.previousInboundBitrateSamples = nextInboundBitrateSamples
    this.previousOutboundBitrateSamples = nextOutboundBitrateSamples

    const total = packetsLost + packetsReceived
    const packetLossPct = total > 0 ? Number(((packetsLost / total) * 100).toFixed(1)) : null

    return {
      roundTripMs,
      packetLossPct,
      jitterMs,
      inboundBitrateKbps:
        inboundBitrateBitsPerSecond > 0
          ? Number((inboundBitrateBitsPerSecond / 1000).toFixed(1))
          : null,
      outboundBitrateKbps:
        outboundBitrateBitsPerSecond > 0
          ? Number((outboundBitrateBitsPerSecond / 1000).toFixed(1))
          : null
    }
  }

  destroy(): void {
    this.cleanupLocalVideoCapture('camera_video')
    this.cleanupLocalVideoCapture('share_video')
    this.cleanupLocalAudioGraph()

    if (this.pc) {
      this.pc.close()
      this.pc = null
    }

    this.onTrack = null
    this.onIceCandidate = null
    this.onConnectionStateChange = null
    this.previousInboundBitrateSamples.clear()
    this.previousOutboundBitrateSamples.clear()
    this.publishMidBySlot = {}
    this.localShareAudioTrack = null
    this.currentCameraProfile = null
    this.currentShareProfile = null
  }

  private buildBitrateSample(stat: RTCStats & Record<string, unknown>): BitrateSample | null {
    if (typeof stat.bytesReceived === 'number' && typeof stat.timestamp === 'number') {
      return {
        bytes: stat.bytesReceived,
        timestampMs: stat.timestamp
      }
    }

    if (typeof stat.bytesSent === 'number' && typeof stat.timestamp === 'number') {
      return {
        bytes: stat.bytesSent,
        timestampMs: stat.timestamp
      }
    }

    return null
  }

  private computeBitrateBitsPerSecond(
    previousSample: BitrateSample | undefined,
    currentSample: BitrateSample
  ): number | null {
    if (!previousSample) {
      return null
    }

    const deltaBytes = currentSample.bytes - previousSample.bytes
    const deltaMs = currentSample.timestampMs - previousSample.timestampMs

    if (deltaBytes <= 0 || deltaMs <= 0) {
      return null
    }

    return (deltaBytes * 8 * 1000) / deltaMs
  }

  private findSenderBySlot(slot: VoiceMediaSlot): RTCRtpSender | null {
    if (!this.pc) {
      return null
    }

    const mid = this.publishMidBySlot[slot]
    if (!mid) {
      return null
    }

    const byTransceiver = this.pc
      .getTransceivers()
      .find((entry) => entry.mid === mid)

    return byTransceiver?.sender ?? null
  }

  private async attachTrackToSlot(
    slot: VoiceMediaSlot,
    track: MediaStreamTrack | null
  ): Promise<void> {
    const sender = this.findSenderBySlot(slot)
    if (!sender) {
      return
    }

    await sender.replaceTrack(track)
  }

  private async applyVideoProfile(
    slot: LocalVisualSlot,
    track: MediaStreamTrack,
    profile: VideoPublishProfile
  ): Promise<void> {
    try {
      track.contentHint = profile.contentHint
    } catch {
      // Ignore unsupported content hints.
    }

    try {
      await track.applyConstraints({
        width: profile.width,
        height: profile.height,
        frameRate: profile.frameRate
      })
    } catch {
      // Some browsers ignore/deny dynamic constraints on captured tracks.
    }

    const sender = this.findSenderBySlot(slot)
    if (!sender) {
      return
    }

    try {
      const params = sender.getParameters()
      const existingEncoding = params.encodings?.[0] ?? {}
      params.encodings = [
        {
          ...existingEncoding,
          maxBitrate: profile.bitrateKbps * 1000,
          maxFramerate: profile.frameRate,
          scaleResolutionDownBy: 1
        }
      ]
      params.degradationPreference = slot === 'share_video' ? 'maintain-resolution' : 'balanced'
      await sender.setParameters(params)
    } catch {
      // Some browsers reject sender parameter changes for captured media.
    }
  }

  private cleanupLocalVideoCapture(slot: LocalVisualSlot): void {
    const sourceStream = this.localVideoSourceStreams[slot]
    if (sourceStream) {
      for (const track of sourceStream.getTracks()) {
        track.stop()
      }
      delete this.localVideoSourceStreams[slot]
    }

    delete this.localVideoPreviewStreams[slot]
  }

  private cleanupLocalAudioGraph(): void {
    if (this.gatePollIntervalId !== null) {
      window.clearInterval(this.gatePollIntervalId)
      this.gatePollIntervalId = null
    }

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        track.stop()
      }
      this.localStream = null
    }

    if (this.rawLocalStream) {
      for (const track of this.rawLocalStream.getTracks()) {
        track.stop()
      }
      this.rawLocalStream = null
    }

    this.inputSourceNode?.disconnect()
    this.inputSourceNode = null
    this.inputGainNode?.disconnect()
    this.inputGainNode = null
    this.gateGainNode?.disconnect()
    this.gateGainNode = null
    this.gateAnalyserNode?.disconnect()
    this.gateAnalyserNode = null
    this.gateAnalyserBuffer = null
    this.inputDestinationNode?.disconnect()
    this.inputDestinationNode = null
    this.gateOpenUntilMs = 0
    this.gateIsOpen = true

    if (this.audioContext) {
      this.audioContext.close().catch(() => {})
      this.audioContext = null
    }
  }

  private startNoiseGateLoop(): void {
    if (this.gatePollIntervalId !== null) {
      window.clearInterval(this.gatePollIntervalId)
    }

    this.updateNoiseGate()
    this.gatePollIntervalId = window.setInterval(() => {
      this.updateNoiseGate()
    }, WebRTCManager.NOISE_GATE_INTERVAL_MS)
  }

  private updateNoiseGate(): void {
    if (!this.gateGainNode || !this.gateAnalyserNode || !this.gateAnalyserBuffer) {
      return
    }

    if (!this.noiseGateEnabled) {
      this.setGateOpen(true)
      return
    }

    this.gateAnalyserNode.getByteTimeDomainData(this.gateAnalyserBuffer)
    const rms = this.computeRms(this.gateAnalyserBuffer)
    const levelDb = 20 * Math.log10(Math.max(rms, WebRTCManager.NOISE_GATE_FLOOR_RMS))
    const now = performance.now()

    if (levelDb >= this.noiseGateThresholdDb) {
      this.gateOpenUntilMs = now + WebRTCManager.NOISE_GATE_HOLD_MS
      this.setGateOpen(true)
      return
    }

    this.setGateOpen(now <= this.gateOpenUntilMs)
  }

  private setGateOpen(open: boolean): void {
    if (!this.gateGainNode) {
      return
    }

    if (this.gateIsOpen === open) {
      return
    }

    const context = this.audioContext
    if (!context) {
      this.gateGainNode.gain.value = open ? 1 : 0
      this.gateIsOpen = open
      return
    }

    const gainParam = this.gateGainNode.gain
    const now = context.currentTime
    const targetValue = open ? 1 : 0
    const rampSeconds = open
      ? WebRTCManager.NOISE_GATE_OPEN_RAMP_SECONDS
      : WebRTCManager.NOISE_GATE_CLOSE_RAMP_SECONDS

    gainParam.cancelScheduledValues(now)
    gainParam.setValueAtTime(gainParam.value, now)
    gainParam.linearRampToValueAtTime(targetValue, now + rampSeconds)
    this.gateIsOpen = open
  }

  private computeRms(samples: Uint8Array): number {
    let sumSquares = 0

    for (const sample of samples) {
      const centered = (sample - 128) / 128
      sumSquares += centered * centered
    }

    return Math.sqrt(sumSquares / samples.length)
  }
}
