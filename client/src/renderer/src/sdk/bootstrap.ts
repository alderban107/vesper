import { SESSION_NOTICE_EVENT, type SessionNotice, type SessionStore } from '@vesper/sdk/api'
import { useSettingsStore } from '../stores/settingsStore'
import { getStoredValue, setStoredValue, removeStoredValue } from '../utils/localStorage'

const SESSION_NOTICE_KEY = 'vesperSessionNotice'

function emitSessionNotice(): void {
  window.dispatchEvent(new CustomEvent(SESSION_NOTICE_EVENT))
}

export { SESSION_NOTICE_EVENT, type SessionNotice }

export const rendererSessionStore: SessionStore = {
  getServerUrl(): string {
    const serverUrl = useSettingsStore.getState().serverUrl.trim()
    if (!serverUrl) {
      throw new Error('Vesper server URL is not configured. Set it before signing in.')
    }

    return serverUrl
  },

  getAccessToken(): string | null {
    return getStoredValue('accessToken')
  },

  getRefreshToken(): string | null {
    return getStoredValue('refreshToken')
  },

  setTokens(accessToken: string, refreshToken: string): void {
    setStoredValue('accessToken', accessToken)
    setStoredValue('refreshToken', refreshToken)
  },

  clearTokens(): void {
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

