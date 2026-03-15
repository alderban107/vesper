const DEFAULT_SERVER_URL =
  (window as any).VESPER_API_URL || 'http://localhost:4000'
const SESSION_NOTICE_KEY = 'vesperSessionNotice'
const SESSION_NOTICE_EVENT = 'vesper:session-notice'

let refreshRequest: Promise<string | null> | null = null

function getServerUrl(): string {
  return localStorage.getItem('serverUrl') || DEFAULT_SERVER_URL
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
    return await fetch(url, options)
  } catch (error) {
    throw normalizeFetchError(error, url)
  }
}

function getAccessToken(): string | null {
  return localStorage.getItem('accessToken')
}

function getRefreshToken(): string | null {
  return localStorage.getItem('refreshToken')
}

function setTokens(access: string, refresh: string): void {
  localStorage.setItem('accessToken', access)
  localStorage.setItem('refreshToken', refresh)
}

function clearTokens(): void {
  localStorage.removeItem('accessToken')
  localStorage.removeItem('refreshToken')
}

export interface SessionNotice {
  title: string
  message: string
}

function emitSessionNotice(): void {
  window.dispatchEvent(new CustomEvent(SESSION_NOTICE_EVENT))
}

function setSessionNotice(notice: SessionNotice): void {
  localStorage.setItem(SESSION_NOTICE_KEY, JSON.stringify(notice))
  emitSessionNotice()
}

function clearSessionNotice(): void {
  localStorage.removeItem(SESSION_NOTICE_KEY)
  emitSessionNotice()
}

function getSessionNotice(): SessionNotice | null {
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
