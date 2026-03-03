import { create } from 'zustand'

const DEFAULT_SERVER_URL = 'http://localhost:4000'

interface SettingsState {
  serverUrl: string
  setServerUrl: (url: string) => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  serverUrl: localStorage.getItem('serverUrl') || DEFAULT_SERVER_URL,

  setServerUrl: (url) => {
    const normalized = url.replace(/\/+$/, '') // strip trailing slashes
    localStorage.setItem('serverUrl', normalized)
    set({ serverUrl: normalized })
  }
}))
