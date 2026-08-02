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

interface TestScope {
  kind: 'channel' | 'dm'
  id: string
}

function resolveActiveChannelScopeIdFromDom(client: VesperClient): string | null {
  const serverName = document
    .querySelector('.vesper-channel-sidebar-title')
    ?.textContent
    ?.trim()
  const channelName = document
    .querySelector('.vesper-channel-row-active .vesper-channel-row-label')
    ?.textContent
    ?.trim()

  if (!serverName || !channelName) {
    return null
  }

  const server = client
    .getState()
    .servers
    .find((entry) => entry.name === serverName)

  return server?.channels.find((channel) => channel.name === channelName)?.id ?? null
}

async function resolveActiveChannelScopeId(client: VesperClient): Promise<string | null> {
  try {
    const { useServerStore } = await import('../stores/serverStore')
    const scopeId = useServerStore.getState().activeChannelId
    if (scopeId) {
      return scopeId
    }
  } catch {
    // Fall back to DOM + client state below.
  }

  return resolveActiveChannelScopeIdFromDom(client)
}

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
    const client = getRendererClient()
    rendererEncryptedChat = client.createEncryptedChat()

    // Expose MLS diagnostics for Playwright E2E assertions.
    // Tests call page.evaluate(() => window.__mlsDiagnostics?.forScope(id))
    // to read counters without coupling to SDK internals.
    ;(window as any).__mlsDiagnostics = rendererEncryptedChat.getDiagnostics()
    ;(window as any).__vesperE2eeTest = {
      resolveActiveChannelScopeId: async () => await resolveActiveChannelScopeId(client),
      hasGroup: (scopeId: string) => rendererEncryptedChat?.hasGroup(scopeId) ?? false,
      getScopeDiagnostics: (scopeId: string) => rendererEncryptedChat?.getDiagnostics().forScope(scopeId) ?? null,
      async getCachedMessageTexts(scopeId: string): Promise<string[]> {
        const messages = await client.runWithStorageContext(async () =>
          await client.getStorageRuntime().loadCachedMessages(scopeId)
        )
        return messages
          .map((message) => message.decryptedContent)
          .filter((content): content is string => typeof content === 'string')
      },
      async prepareScopeForRead(
        scope: TestScope,
        options: {
          lastKnownEpoch?: number | null
          reason?: string | null
        } = {}
      ): Promise<boolean> {
        if (!rendererEncryptedChat) {
          return false
        }

        return await rendererEncryptedChat.prepareScopeForRead(scope, options)
      }
    }
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
