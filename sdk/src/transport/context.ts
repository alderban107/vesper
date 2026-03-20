import {
  createBrowserSessionStore,
  createMemorySessionStore,
  type SessionStore,
  VesperHttpClient
} from '../api/client.js'
import {
  type VesperSocketClientOptions,
  VesperSocketClient
} from '../api/socket.js'

export interface VesperTransportOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
  sessionStore?: SessionStore
  socketOptions?: Omit<VesperSocketClientOptions, 'getAccessToken' | 'getServerUrl'>
}

export interface VesperTransport {
  sessionStore: SessionStore
  httpClient: VesperHttpClient
  socketClient: VesperSocketClient
}

function resolveSessionStore(options: VesperTransportOptions): SessionStore {
  if (options.sessionStore) {
    return options.sessionStore
  }

  if (typeof window === 'undefined') {
    if (typeof options.baseUrl !== 'string' || options.baseUrl.trim().length === 0) {
      throw new Error('Vesper transport requires a baseUrl outside the browser.')
    }

    return createMemorySessionStore(options.baseUrl)
  }

  return createBrowserSessionStore(options.baseUrl ?? null)
}

export function createVesperTransport(
  options: VesperTransportOptions = {}
): VesperTransport {
  const sessionStore = resolveSessionStore(options)
  const httpClient = new VesperHttpClient({
    fetchImpl: options.fetchImpl,
    sessionStore
  })
  const socketClient = new VesperSocketClient({
    ...options.socketOptions,
    getAccessToken: () => httpClient.getAccessToken(),
    getServerUrl: () => httpClient.getServerUrl()
  })

  return {
    sessionStore,
    httpClient,
    socketClient
  }
}
