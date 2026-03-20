const DEFAULT_SERVER_URL = (() => {
  if (
    typeof window !== 'undefined' &&
    typeof (window as { VESPER_API_URL?: string }).VESPER_API_URL === 'string'
  ) {
    return (window as { VESPER_API_URL?: string }).VESPER_API_URL as string
  }

  return null
})()
const SESSION_NOTICE_KEY = 'vesperSessionNotice'
const SESSION_NOTICE_EVENT = 'vesper:session-notice'

export interface SessionStore {
  getServerUrl(): string
  getAccessToken(): string | null
  getRefreshToken(): string | null
  setTokens(accessToken: string, refreshToken: string): void
  clearTokens(): void
  setSessionNotice(notice: SessionNotice): void
  clearSessionNotice(): void
  getSessionNotice(): SessionNotice | null
  emitSessionNotice(): void
}

class BrowserSessionStore implements SessionStore {
  private readonly fallbackServerUrl: string | null

  constructor(fallbackServerUrl: string | null = DEFAULT_SERVER_URL) {
    this.fallbackServerUrl = fallbackServerUrl
  }

  getServerUrl(): string {
    const storedUrl = localStorage.getItem('serverUrl')
    const resolvedUrl = storedUrl || this.fallbackServerUrl

    if (!resolvedUrl) {
      throw new Error(
        'Vesper base URL is not configured. Set VESPER_API_URL or provide a SessionStore with a server URL.'
      )
    }

    return resolvedUrl
  }

  getAccessToken(): string | null {
    return localStorage.getItem('accessToken')
  }

  getRefreshToken(): string | null {
    return localStorage.getItem('refreshToken')
  }

  setTokens(accessToken: string, refreshToken: string): void {
    localStorage.setItem('accessToken', accessToken)
    localStorage.setItem('refreshToken', refreshToken)
  }

  clearTokens(): void {
    localStorage.removeItem('accessToken')
    localStorage.removeItem('refreshToken')
  }

  setSessionNotice(notice: SessionNotice): void {
    localStorage.setItem(SESSION_NOTICE_KEY, JSON.stringify(notice))
    this.emitSessionNotice()
  }

  clearSessionNotice(): void {
    localStorage.removeItem(SESSION_NOTICE_KEY)
    this.emitSessionNotice()
  }

  getSessionNotice(): SessionNotice | null {
    const raw = localStorage.getItem(SESSION_NOTICE_KEY)
    if (!raw) {
      return null
    }

    try {
      const parsed = JSON.parse(raw) as Partial<SessionNotice>
      if (typeof parsed.title === 'string' && typeof parsed.message === 'string') {
        return {
          title: parsed.title,
          message: parsed.message
        }
      }
    } catch {
      // Ignore malformed stored data.
    }

    localStorage.removeItem(SESSION_NOTICE_KEY)
    return null
  }

  emitSessionNotice(): void {
    window.dispatchEvent(new CustomEvent(SESSION_NOTICE_EVENT))
  }
}

class MemorySessionStore implements SessionStore {
  private accessToken: string | null = null
  private refreshToken: string | null = null
  private notice: SessionNotice | null = null
  private serverUrl: string

  constructor(serverUrl: string) {
    if (!serverUrl.trim()) {
      throw new Error('MemorySessionStore requires an explicit server URL.')
    }

    this.serverUrl = serverUrl
  }

  getServerUrl(): string {
    return this.serverUrl
  }

  setServerUrl(serverUrl: string): void {
    this.serverUrl = serverUrl
  }

  getAccessToken(): string | null {
    return this.accessToken
  }

  getRefreshToken(): string | null {
    return this.refreshToken
  }

  setTokens(accessToken: string, refreshToken: string): void {
    this.accessToken = accessToken
    this.refreshToken = refreshToken
  }

  clearTokens(): void {
    this.accessToken = null
    this.refreshToken = null
  }

  setSessionNotice(notice: SessionNotice): void {
    this.notice = notice
  }

  clearSessionNotice(): void {
    this.notice = null
  }

  getSessionNotice(): SessionNotice | null {
    return this.notice
  }

  emitSessionNotice(): void {}
}

let sessionStore: SessionStore = new BrowserSessionStore()

function isNetworkError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    /failed to fetch|networkerror|load failed/i.test(error.message)
  )
}

function normalizeFetchError(error: unknown, url: string): Error {
  if (isNetworkError(error)) {
    const origin = (() => {
      try {
        return new URL(url).origin
      } catch {
        return url
      }
    })()

    return new Error(
      `Could not reach the Vesper server at ${origin}. Check that the backend is running and your server URL is correct.`
    )
  }

  return error instanceof Error ? error : new Error('Request failed')
}

async function performFetch(url: string, options: RequestInit): Promise<Response> {
  try {
    return await globalThis.fetch(url, options)
  } catch (error) {
    throw normalizeFetchError(error, url)
  }
}

export interface SessionNotice {
  title: string
  message: string
}

export function createMemorySessionStore(serverUrl: string): SessionStore {
  return new MemorySessionStore(serverUrl)
}

export function createBrowserSessionStore(defaultServerUrl?: string | null): SessionStore {
  return new BrowserSessionStore(defaultServerUrl)
}

export class VesperHttpClient {
  private refreshRequest: Promise<string | null> | null = null
  private fetchImpl: typeof fetch
  private sessionStore: SessionStore

  constructor(config: {
    fetchImpl?: typeof fetch
    sessionStore?: SessionStore
  } = {}) {
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.sessionStore = config.sessionStore ?? sessionStore
  }

  configure(config: {
    fetchImpl?: typeof fetch
    sessionStore?: SessionStore
  }): void {
    if (config.fetchImpl) {
      this.fetchImpl = config.fetchImpl
    }

    if (config.sessionStore) {
      this.sessionStore = config.sessionStore
    }
  }

  getSessionStore(): SessionStore {
    return this.sessionStore
  }

  getServerUrl(): string {
    return this.sessionStore.getServerUrl()
  }

  getAccessToken(): string | null {
    return this.sessionStore.getAccessToken()
  }

  getRefreshToken(): string | null {
    return this.sessionStore.getRefreshToken()
  }

  setTokens(access: string, refresh: string): void {
    this.sessionStore.setTokens(access, refresh)
  }

  clearTokens(): void {
    this.sessionStore.clearTokens()
  }

  emitSessionNotice(): void {
    this.sessionStore.emitSessionNotice()
  }

  setSessionNotice(notice: SessionNotice): void {
    this.sessionStore.setSessionNotice(notice)
  }

  clearSessionNotice(): void {
    this.sessionStore.clearSessionNotice()
  }

  getSessionNotice(): SessionNotice | null {
    return this.sessionStore.getSessionNotice()
  }

  async apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
    const url = `${this.getServerUrl()}${path}`
    const token = this.getAccessToken()
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>)
    }

    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    let response = await this.performFetch(url, { ...options, headers })

    if (response.status === 401 && token) {
      const newToken = await this.refreshAccessToken()
      if (newToken) {
        headers['Authorization'] = `Bearer ${newToken}`
        response = await this.performFetch(url, { ...options, headers })
      }
    }

    return response
  }

  async apiUpload(path: string, formData: FormData): Promise<Response> {
    const url = `${this.getServerUrl()}${path}`
    const token = this.getAccessToken()
    const headers: Record<string, string> = {}

    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    let response = await this.performFetch(url, { method: 'POST', headers, body: formData })

    if (response.status === 401 && token) {
      const newToken = await this.refreshAccessToken()
      if (newToken) {
        headers['Authorization'] = `Bearer ${newToken}`
        response = await this.performFetch(url, { method: 'POST', headers, body: formData })
      }
    }

    return response
  }

  private async performFetch(url: string, options: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, options)
    } catch (error) {
      throw normalizeFetchError(error, url)
    }
  }

  private async refreshAccessToken(): Promise<string | null> {
    if (this.refreshRequest) {
      return this.refreshRequest
    }

    const refreshToken = this.getRefreshToken()
    if (!refreshToken) {
      return null
    }

    this.refreshRequest = (async () => {
      try {
        const response = await this.performFetch(`${this.getServerUrl()}/api/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken })
        })

        if (!response.ok) {
          this.clearTokens()
          this.setSessionNotice({
            title: 'Sign in again on this device',
            message:
              'This session can no longer be renewed. If this device was signed in before device-based sessions shipped, one fresh login is required.'
          })
          return null
        }

        const data = await response.json()
        this.setTokens(data.access_token, data.refresh_token)
        this.clearSessionNotice()
        return data.access_token
      } catch {
        this.clearTokens()
        return null
      } finally {
        this.refreshRequest = null
      }
    })()

    return this.refreshRequest
  }
}

const defaultHttpClient = new VesperHttpClient()

export function getDefaultHttpClient(): VesperHttpClient {
  return defaultHttpClient
}

export function configureHttpClient(config: {
  fetchImpl?: typeof fetch
  sessionStore?: SessionStore
}): void {
  defaultHttpClient.configure(config)

  if (config.sessionStore) {
    sessionStore = config.sessionStore
  }
}

export function getServerUrl(): string {
  return defaultHttpClient.getServerUrl()
}

export function getAccessToken(): string | null {
  return defaultHttpClient.getAccessToken()
}

export function getRefreshToken(): string | null {
  return defaultHttpClient.getRefreshToken()
}

export function setTokens(access: string, refresh: string): void {
  defaultHttpClient.setTokens(access, refresh)
}

export function clearTokens(): void {
  defaultHttpClient.clearTokens()
}

function emitSessionNotice(): void {
  defaultHttpClient.emitSessionNotice()
}

function setSessionNotice(notice: SessionNotice): void {
  defaultHttpClient.setSessionNotice(notice)
}

function clearSessionNotice(): void {
  defaultHttpClient.clearSessionNotice()
}

function getSessionNotice(): SessionNotice | null {
  return defaultHttpClient.getSessionNotice()
}

export async function apiFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  return await defaultHttpClient.apiFetch(path, options)
}

export async function apiUpload(
  path: string,
  formData: FormData
): Promise<Response> {
  return await defaultHttpClient.apiUpload(path, formData)
}

export {
  SESSION_NOTICE_EVENT,
  clearSessionNotice,
  getSessionNotice
}
