import { create } from 'zustand'
import { getStoredValue, setStoredValue, writeStoredValue } from '../utils/localStorage'

const LINK_PREVIEWS_STORAGE_KEY = 'linkPreviews'
const ANON_FILENAMES_KEY = 'privacy:anonFilenames'
const STRIP_EXIF_KEY = 'privacy:stripExif'

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
  anonFilenames: boolean
  stripExif: boolean
  setServerUrl: (url: string) => void
  setLinkPreviewsEnabled: (enabled: boolean) => void
  setAnonFilenames: (enabled: boolean) => void
  setStripExif: (enabled: boolean) => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  serverUrl: getInitialServerUrl(),
  linkPreviewsEnabled: getStoredValue(LINK_PREVIEWS_STORAGE_KEY) === 'enabled',
  anonFilenames: getStoredValue(ANON_FILENAMES_KEY) === 'enabled',
  stripExif: getStoredValue(STRIP_EXIF_KEY) !== 'disabled', // on by default

  setServerUrl: (url) => {
    const normalized = normalizeServerUrl(url)
    writeStoredValue('serverUrl', normalized || null)
    set({ serverUrl: normalized })
  },

  setLinkPreviewsEnabled: (enabled) => {
    setStoredValue(LINK_PREVIEWS_STORAGE_KEY, enabled ? 'enabled' : 'disabled')
    set({ linkPreviewsEnabled: enabled })
  },

  setAnonFilenames: (enabled) => {
    setStoredValue(ANON_FILENAMES_KEY, enabled ? 'enabled' : 'disabled')
    set({ anonFilenames: enabled })
  },

  setStripExif: (enabled) => {
    setStoredValue(STRIP_EXIF_KEY, enabled ? 'enabled' : 'disabled')
    set({ stripExif: enabled })
  }
}))
