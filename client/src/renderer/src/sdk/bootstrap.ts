import { SESSION_NOTICE_EVENT, type SessionNotice, type SessionStore } from '@vesper/sdk/api'
import { useSettingsStore } from '../stores/settingsStore'
import { getStoredValue, setStoredValue, removeStoredValue } from '../utils/localStorage'

const SESSION_NOTICE_KEY = 'vesperSessionNotice'
const desktopAuthSession = window.authSession
let desktopAccessToken: string | null = null

if (desktopAuthSession) {
  desktopAccessToken = getStoredValue('accessToken')
  const legacyRefreshToken = getStoredValue('refreshToken')
  const serverUrl = useSettingsStore.getState().serverUrl.trim()
  if (
    legacyRefreshToken &&
    serverUrl &&
    desktopAuthSession.setRefreshToken(legacyRefreshToken, serverUrl)
  ) {
    removeStoredValue('refreshToken')
  }
  removeStoredValue('accessToken')
}

function emitSessionNotice(): void {
  window.dispatchEvent(new CustomEvent(SESSION_NOTICE_EVENT))
}

export { SESSION_NOTICE_EVENT, type SessionNotice }

const sessionStore: SessionStore = {
  getServerUrl(): string {
    const serverUrl = useSettingsStore.getState().serverUrl.trim()
    if (!serverUrl) {
      throw new Error('Vesper server URL is not configured. Set it before signing in.')
    }

    return serverUrl
  },

  getAccessToken(): string | null {
    return desktopAuthSession ? desktopAccessToken : getStoredValue('accessToken')
  },

  getRefreshToken(): string | null {
    return desktopAuthSession ? null : getStoredValue('refreshToken')
  },

  setTokens(accessToken: string, refreshToken: string): void {
    if (desktopAuthSession) {
      if (!desktopAuthSession.setRefreshToken(refreshToken, sessionStore.getServerUrl())) {
        throw new Error('Could not store the desktop refresh token securely')
      }
      desktopAccessToken = accessToken
      return
    }

    setStoredValue('accessToken', accessToken)
    setStoredValue('refreshToken', refreshToken)
  },

  clearTokens(): void {
    if (desktopAuthSession) {
      desktopAccessToken = null
      desktopAuthSession.clearRefreshToken()
      return
    }

    removeStoredValue('accessToken')
    removeStoredValue('refreshToken')
  },

  setSessionNotice(notice: SessionNotice): void {
    setStoredValue(SESSION_NOTICE_KEY, JSON.stringify(notice))
    emitSessionNotice()
  },

  clearSessionNotice(): void {
    removeStoredValue(SESSION_NOTICE_KEY)
    emitSessionNotice()
  },

  getSessionNotice(): SessionNotice | null {
    const raw = getStoredValue(SESSION_NOTICE_KEY)
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
      removeStoredValue(SESSION_NOTICE_KEY)
    }

    return null
  },

  emitSessionNotice
}

if (desktopAuthSession) {
  sessionStore.refreshAccessToken = async () => {
    const result = await desktopAuthSession.refreshAccessToken(sessionStore.getServerUrl())
    if (result.status === 'ok') {
      desktopAccessToken = result.accessToken
    } else if (result.status === 'invalid') {
      desktopAccessToken = null
    }
    return result
  }
}

export const rendererSessionStore = sessionStore
