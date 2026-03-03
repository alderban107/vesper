export class AudioManager {
  private audioElements: Map<string, HTMLAudioElement> = new Map()
  private audioContext: AudioContext | null = null
  private analysers: Map<string, { analyser: AnalyserNode; source: MediaStreamAudioSourceNode }> =
    new Map()
  private localAnalyser: { analyser: AnalyserNode; source: MediaStreamAudioSourceNode } | null =
    null
  private speakingCallback: ((levels: Map<string, boolean>) => void) | null = null
  private animFrameId: number | null = null
  private deafened = false

  // Threshold for "speaking" — RMS amplitude 0-1, tuned for voice
  private static SPEAKING_THRESHOLD = 0.01

  addRemoteTrack(trackId: string, track: MediaStreamTrack): void {
    // Remove existing element for this track if any
    this.removeRemoteTrack(trackId)

    const audio = document.createElement('audio')
    const stream = new MediaStream([track])
    audio.srcObject = stream
    audio.autoplay = true
    audio.muted = this.deafened

    audio.play().catch(() => {
      // Autoplay may be blocked — user interaction will unblock
    })

    this.audioElements.set(trackId, audio)

    // Set up analyser for speaking detection
    this.ensureAudioContext()
    if (this.audioContext) {
      const source = this.audioContext.createMediaStreamSource(stream)
      const analyser = this.audioContext.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.5
      source.connect(analyser)
      this.analysers.set(trackId, { analyser, source })
    }
  }

  removeRemoteTrack(trackId: string): void {
    const audio = this.audioElements.get(trackId)
    if (audio) {
      audio.pause()
      audio.srcObject = null
      this.audioElements.delete(trackId)
    }

    const entry = this.analysers.get(trackId)
    if (entry) {
      entry.source.disconnect()
      this.analysers.delete(trackId)
    }
  }

  /** Set up analyser for the local mic stream to detect self-speaking */
  setLocalStream(stream: MediaStream): void {
    this.cleanupLocalAnalyser()
    this.ensureAudioContext()
    if (this.audioContext) {
      const source = this.audioContext.createMediaStreamSource(stream)
      const analyser = this.audioContext.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.5
      source.connect(analyser)
      this.localAnalyser = { analyser, source }
    }
  }

  /** Register callback for speaking level updates. Starts the polling loop. */
  onSpeakingChange(callback: (levels: Map<string, boolean>) => void): void {
    this.speakingCallback = callback
    this.startPolling()
  }

  /** Set audio output device for all remote tracks */
  setOutputDevice(deviceId: string | null): void {
    for (const audio of this.audioElements.values()) {
      if ('setSinkId' in audio && deviceId) {
        ;(audio as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> })
          .setSinkId(deviceId)
          .catch(() => {})
      }
    }
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened
    for (const audio of this.audioElements.values()) {
      audio.muted = deafened
    }
  }

  destroy(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId)
      this.animFrameId = null
    }

    for (const audio of this.audioElements.values()) {
      audio.pause()
      audio.srcObject = null
    }
    this.audioElements.clear()

    for (const { source } of this.analysers.values()) {
      source.disconnect()
    }
    this.analysers.clear()

    this.cleanupLocalAnalyser()

    if (this.audioContext) {
      this.audioContext.close().catch(() => {})
      this.audioContext = null
    }

    this.speakingCallback = null
  }

  private ensureAudioContext(): void {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new AudioContext()
    }
  }

  private cleanupLocalAnalyser(): void {
    if (this.localAnalyser) {
      this.localAnalyser.source.disconnect()
      this.localAnalyser = null
    }
  }

  private startPolling(): void {
    if (this.animFrameId !== null) return

    const poll = (): void => {
      if (!this.speakingCallback) return

      const levels = new Map<string, boolean>()

      // Check local mic
      if (this.localAnalyser) {
        levels.set('__local__', this.isSpeaking(this.localAnalyser.analyser))
      }

      // Check remote tracks
      for (const [trackId, { analyser }] of this.analysers) {
        levels.set(trackId, this.isSpeaking(analyser))
      }

      this.speakingCallback(levels)
      this.animFrameId = requestAnimationFrame(poll)
    }

    this.animFrameId = requestAnimationFrame(poll)
  }

  private isSpeaking(analyser: AnalyserNode): boolean {
    const data = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(data)

    // Compute RMS
    let sum = 0
    for (let i = 0; i < data.length; i++) {
      sum += data[i] * data[i]
    }
    const rms = Math.sqrt(sum / data.length)

    return rms > AudioManager.SPEAKING_THRESHOLD
  }
}
