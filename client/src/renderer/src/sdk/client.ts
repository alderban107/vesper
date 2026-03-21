import {
  createVesperClient,
  type VesperClient,
  type VesperEncryptedChat
} from '@vesper/sdk/client'
import { getLocalDeviceIdentity } from '@vesper/sdk/auth'
import type { CryptoStorageRuntime } from '@vesper/sdk/storage'
import { rendererSessionStore } from './bootstrap'

let rendererClient: VesperClient | null = null
let rendererEncryptedChat: VesperEncryptedChat | null = null

export function getRendererClient(): VesperClient {
  if (!rendererClient) {
    rendererClient = createVesperClient({
      sessionStore: rendererSessionStore,
      auth: {
        getDeviceIdentity: getLocalDeviceIdentity
      }
    })
  }

  return rendererClient
}

export function getRendererEncryptedChat(): VesperEncryptedChat {
  if (!rendererEncryptedChat) {
    rendererEncryptedChat = getRendererClient().createEncryptedChat()

    // Expose MLS diagnostics for Playwright E2E assertions.
    // Tests call page.evaluate(() => window.__mlsDiagnostics?.forScope(id))
    // to read counters without coupling to SDK internals.
    ;(window as any).__mlsDiagnostics = rendererEncryptedChat.getDiagnostics()
  }

  return rendererEncryptedChat
}

export function getRendererStorageRuntime(): CryptoStorageRuntime {
  return getRendererClient().getStorageRuntime()
}

export function resetRendererClient(): void {
  rendererEncryptedChat?.reset()
  rendererEncryptedChat = null
  rendererClient?.stop()
  rendererClient = null
}
