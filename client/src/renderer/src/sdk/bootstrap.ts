import {
  SESSION_NOTICE_EVENT,
  configureHttpClient,
  type SessionNotice,
  type SessionStore
} from '@vesper/sdk/transport'
import { useSettingsStore } from '../stores/settingsStore'

const SESSION_NOTICE_KEY = 'vesperSessionNotice'

function getStoredValue(key: string): string | null {
  return localStorage.getItem(key)
}

function setStoredValue(key: string, value: string): void {
  localStorage.setItem(key, value)
}

function removeStoredValue(key: string): void {
  localStorage.removeItem(key)
}

function emitSessionNotice(): void {
  window.dispatchEvent(new CustomEvent(SESSION_NOTICE_EVENT))
}

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

let initialized = false

export function bootstrapSdkClient(): void {
  if (initialized) {
    return
  }

  configureHttpClient({
    sessionStore: rendererSessionStore
  })
  initialized = true
}
