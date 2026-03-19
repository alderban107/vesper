import { create } from 'zustand'
import { getStoredValue, setStoredValue, writeStoredValue } from '../utils/localStorage'

const LINK_PREVIEWS_STORAGE_KEY = 'linkPreviews'

function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function getInitialServerUrl(): string {
  const stored = getStoredValue('serverUrl')
  if (stored) {
    return normalizeServerUrl(stored)
  }

  if (typeof window === 'undefined') return ''
  const configured = (window as { VESPER_API_URL?: string }).VESPER_API_URL
  return typeof configured === 'string' ? normalizeServerUrl(configured) : ''
}

interface SettingsState {
  serverUrl: string
  linkPreviewsEnabled: boolean
  setServerUrl: (url: string) => void
  setLinkPreviewsEnabled: (enabled: boolean) => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  serverUrl: getInitialServerUrl(),
  linkPreviewsEnabled: getStoredValue(LINK_PREVIEWS_STORAGE_KEY) === 'enabled',

  setServerUrl: (url) => {
    const normalized = normalizeServerUrl(url)
    writeStoredValue('serverUrl', normalized || null)
    set({ serverUrl: normalized })
  },

  setLinkPreviewsEnabled: (enabled) => {
    setStoredValue(LINK_PREVIEWS_STORAGE_KEY, enabled ? 'enabled' : 'disabled')
    set({ linkPreviewsEnabled: enabled })
  }
}))
