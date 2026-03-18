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

let refreshRequest: Promise<string | null> | null = null
let fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)

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

function getServerUrl(): string {
  return sessionStore.getServerUrl()
}

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
    return await fetchImpl(url, options)
  } catch (error) {
    throw normalizeFetchError(error, url)
  }
}

function getAccessToken(): string | null {
  return sessionStore.getAccessToken()
}

function getRefreshToken(): string | null {
  return sessionStore.getRefreshToken()
}

function setTokens(access: string, refresh: string): void {
  sessionStore.setTokens(access, refresh)
}

function clearTokens(): void {
  sessionStore.clearTokens()
}

export interface SessionNotice {
  title: string
  message: string
}

function emitSessionNotice(): void {
  sessionStore.emitSessionNotice()
}

function setSessionNotice(notice: SessionNotice): void {
  sessionStore.setSessionNotice(notice)
}

function clearSessionNotice(): void {
  sessionStore.clearSessionNotice()
}

function getSessionNotice(): SessionNotice | null {
  return sessionStore.getSessionNotice()
}

export function configureHttpClient(config: {
  fetchImpl?: typeof fetch
  sessionStore?: SessionStore
}): void {
  if (config.fetchImpl) {
    fetchImpl = config.fetchImpl
  }

  if (config.sessionStore) {
    sessionStore = config.sessionStore
  }
}

export function createMemorySessionStore(serverUrl: string): SessionStore {
  return new MemorySessionStore(serverUrl)
}

export function createBrowserSessionStore(defaultServerUrl?: string | null): SessionStore {
  return new BrowserSessionStore(defaultServerUrl)
}

async function refreshAccessToken(): Promise<string | null> {
  if (refreshRequest) {
    return refreshRequest
  }

  const refreshToken = getRefreshToken()
  if (!refreshToken) return null

  refreshRequest = (async () => {
    try {
      const url = `${getServerUrl()}/api/v1/auth/refresh`
      const res = await performFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken })
      })

      if (!res.ok) {
        clearTokens()
        setSessionNotice({
          title: 'Sign in again on this device',
          message:
            'This session can no longer be renewed. If this device was signed in before device-based sessions shipped, one fresh login is required.'
        })
        return null
      }

      const data = await res.json()
      setTokens(data.access_token, data.refresh_token)
      clearSessionNotice()
      return data.access_token
    } catch {
      clearTokens()
      return null
    } finally {
      refreshRequest = null
    }
  })()

  return refreshRequest
}

export async function apiFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = `${getServerUrl()}${path}`
  let token = getAccessToken()

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>)
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  let res = await performFetch(url, { ...options, headers })

  // If 401, try refreshing the token
  if (res.status === 401 && token) {
    const newToken = await refreshAccessToken()
    if (newToken) {
      headers['Authorization'] = `Bearer ${newToken}`
      res = await performFetch(url, { ...options, headers })
    }
  }

  return res
}

export async function apiUpload(
  path: string,
  formData: FormData
): Promise<Response> {
  const url = `${getServerUrl()}${path}`
  let token = getAccessToken()

  const headers: Record<string, string> = {}
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  let res = await performFetch(url, { method: 'POST', headers, body: formData })

  if (res.status === 401 && token) {
    const newToken = await refreshAccessToken()
    if (newToken) {
      headers['Authorization'] = `Bearer ${newToken}`
      res = await performFetch(url, { method: 'POST', headers, body: formData })
  }
  }

  return res
}

export {
  SESSION_NOTICE_EVENT,
  clearSessionNotice,
  getServerUrl,
  getAccessToken,
  getRefreshToken,
  getSessionNotice,
  setTokens,
  clearTokens
}
