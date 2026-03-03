const DEFAULT_SERVER_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'

function getServerUrl(): string {
  return localStorage.getItem('serverUrl') || DEFAULT_SERVER_URL
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

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = getRefreshToken()
  if (!refreshToken) return null

  try {
    const res = await fetch(`${getServerUrl()}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken })
    })

    if (!res.ok) {
      clearTokens()
      return null
    }

    const data = await res.json()
    setTokens(data.access_token, data.refresh_token)
    return data.access_token
  } catch {
    clearTokens()
    return null
  }
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

  let res = await fetch(url, { ...options, headers })

  // If 401, try refreshing the token
  if (res.status === 401 && token) {
    const newToken = await refreshAccessToken()
    if (newToken) {
      headers['Authorization'] = `Bearer ${newToken}`
      res = await fetch(url, { ...options, headers })
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

  let res = await fetch(url, { method: 'POST', headers, body: formData })

  if (res.status === 401 && token) {
    const newToken = await refreshAccessToken()
    if (newToken) {
      headers['Authorization'] = `Bearer ${newToken}`
      res = await fetch(url, { method: 'POST', headers, body: formData })
    }
  }

  return res
}

export { getServerUrl, getAccessToken, getRefreshToken, setTokens, clearTokens }
