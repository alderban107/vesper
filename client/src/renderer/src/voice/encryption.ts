// VoiceEncryption coordinator — manages the Web Worker and applies
// RTCRtpScriptTransform to senders/receivers for E2EE voice

export class VoiceEncryption {
  private worker: Worker | null = null

  init(): void {
    this.worker = new Worker(
      new URL('./e2ee-worker.ts', import.meta.url),
      { type: 'module' }
    )
  }

  setKey(key: Uint8Array): void {
    this.worker?.postMessage({ type: 'set_key', key })
  }

  applySenderTransform(sender: RTCRtpSender, mediaKind: 'audio' | 'video' = 'audio'): void {
    if (!this.worker) return
    if (!('RTCRtpScriptTransform' in window)) {
      console.warn('RTCRtpScriptTransform not supported — voice E2EE disabled')
      return
    }

    // @ts-expect-error RTCRtpScriptTransform is not yet in TypeScript's lib
    sender.transform = new RTCRtpScriptTransform(this.worker, {
      operation: 'encrypt',
      mediaKind
    })
  }

  applyReceiverTransform(receiver: RTCRtpReceiver, mediaKind: 'audio' | 'video' = 'audio'): void {
    if (!this.worker) return
    if (!('RTCRtpScriptTransform' in window)) return

    // @ts-expect-error RTCRtpScriptTransform is not yet in TypeScript's lib
    receiver.transform = new RTCRtpScriptTransform(this.worker, {
      operation: 'decrypt',
      mediaKind
    })
  }

  destroy(): void {
    if (this.worker) {
      this.worker.postMessage({ type: 'clear' })
      this.worker.terminate()
      this.worker = null
    }
  }
}
