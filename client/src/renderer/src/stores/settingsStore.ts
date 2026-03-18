import { create } from 'zustand'

const LINK_PREVIEWS_STORAGE_KEY = 'linkPreviews'

function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function getInitialServerUrl(): string {
  const stored = localStorage.getItem('serverUrl')
  if (stored) {
    return normalizeServerUrl(stored)
  }

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
  linkPreviewsEnabled: localStorage.getItem(LINK_PREVIEWS_STORAGE_KEY) === 'enabled',

  setServerUrl: (url) => {
    const normalized = normalizeServerUrl(url)
    if (normalized) {
      localStorage.setItem('serverUrl', normalized)
    } else {
      localStorage.removeItem('serverUrl')
    }
    set({ serverUrl: normalized })
  },

  setLinkPreviewsEnabled: (enabled) => {
    localStorage.setItem(LINK_PREVIEWS_STORAGE_KEY, enabled ? 'enabled' : 'disabled')
    set({ linkPreviewsEnabled: enabled })
  }
}))
