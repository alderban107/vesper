import { create } from 'zustand'

const DEFAULT_SERVER_URL =
  (window as any).VESPER_API_URL || 'http://localhost:4000'
const LINK_PREVIEWS_STORAGE_KEY = 'linkPreviews'

interface SettingsState {
  serverUrl: string
  linkPreviewsEnabled: boolean
  setServerUrl: (url: string) => void
  setLinkPreviewsEnabled: (enabled: boolean) => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  serverUrl: localStorage.getItem('serverUrl') || DEFAULT_SERVER_URL,
  linkPreviewsEnabled: localStorage.getItem(LINK_PREVIEWS_STORAGE_KEY) === 'enabled',

  setServerUrl: (url) => {
    const normalized = url.replace(/\/+$/, '') // strip trailing slashes
    localStorage.setItem('serverUrl', normalized)
    set({ serverUrl: normalized })
  },

  setLinkPreviewsEnabled: (enabled) => {
    localStorage.setItem(LINK_PREVIEWS_STORAGE_KEY, enabled ? 'enabled' : 'disabled')
    set({ linkPreviewsEnabled: enabled })
  }
}))
