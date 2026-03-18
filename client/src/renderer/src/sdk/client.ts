import {
  createVesperClient,
  type VesperClient,
  type VesperEncryptedChat
} from '@vesper/sdk/client'
import { getLocalDeviceIdentity } from '@vesper/sdk/auth'
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
  }

  return rendererEncryptedChat
}

export function resetRendererClient(): void {
  rendererEncryptedChat?.reset()
  rendererEncryptedChat = null
  rendererClient?.stop()
  rendererClient = null
}
