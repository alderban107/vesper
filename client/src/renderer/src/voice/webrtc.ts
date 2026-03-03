export class WebRTCManager {
  private pc: RTCPeerConnection | null = null
  private localStream: MediaStream | null = null
  private onTrack: ((event: RTCTrackEvent) => void) | null = null
  private onIceCandidate: ((candidate: RTCIceCandidate) => void) | null = null
  private onConnectionStateChange: ((state: RTCPeerConnectionState) => void) | null = null

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

  async startAudio(deviceId?: string): Promise<void> {
    const constraints: MediaStreamConstraints = {
      audio: deviceId ? { deviceId: { exact: deviceId } } : true
    }

    this.localStream = await navigator.mediaDevices.getUserMedia(constraints)

    const audioTrack = this.localStream.getAudioTracks()[0]
    if (audioTrack && this.pc) {
      this.pc.addTrack(audioTrack, this.localStream)
    }
  }

  async handleOffer(sdp: string): Promise<string> {
    if (!this.pc) throw new Error('PeerConnection not initialized')

    await this.pc.setRemoteDescription({ type: 'offer', sdp })
    const answer = await this.pc.createAnswer()
    await this.pc.setLocalDescription(answer)

    return answer.sdp!
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

  destroy(): void {
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        track.stop()
      }
      this.localStream = null
    }

    if (this.pc) {
      this.pc.close()
      this.pc = null
    }

    this.onTrack = null
    this.onIceCandidate = null
    this.onConnectionStateChange = null
  }
}
