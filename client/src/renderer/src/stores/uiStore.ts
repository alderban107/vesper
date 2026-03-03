import { create } from 'zustand'

interface UIState {
  showCreateServerModal: boolean
  showJoinServerModal: boolean
  showCreateChannelModal: boolean
  showNewDmModal: boolean
  showSettingsModal: boolean
  showRoleManager: boolean
  showServerSettingsModal: boolean
  showPins: boolean

  openCreateServerModal: () => void
  closeCreateServerModal: () => void
  openJoinServerModal: () => void
  closeJoinServerModal: () => void
  openCreateChannelModal: () => void
  closeCreateChannelModal: () => void
  openNewDmModal: () => void
  closeNewDmModal: () => void
  openSettingsModal: () => void
  closeSettingsModal: () => void
  openRoleManager: () => void
  closeRoleManager: () => void
  openServerSettingsModal: () => void
  closeServerSettingsModal: () => void
  togglePins: () => void
  closePins: () => void
}

export const useUIStore = create<UIState>((set) => ({
  showCreateServerModal: false,
  showJoinServerModal: false,
  showCreateChannelModal: false,
  showNewDmModal: false,
  showSettingsModal: false,
  showRoleManager: false,
  showServerSettingsModal: false,
  showPins: false,

  openCreateServerModal: () => set({ showCreateServerModal: true }),
  closeCreateServerModal: () => set({ showCreateServerModal: false }),
  openJoinServerModal: () => set({ showJoinServerModal: true }),
  closeJoinServerModal: () => set({ showJoinServerModal: false }),
  openCreateChannelModal: () => set({ showCreateChannelModal: true }),
  closeCreateChannelModal: () => set({ showCreateChannelModal: false }),
  openNewDmModal: () => set({ showNewDmModal: true }),
  closeNewDmModal: () => set({ showNewDmModal: false }),
  openSettingsModal: () => set({ showSettingsModal: true }),
  closeSettingsModal: () => set({ showSettingsModal: false }),
  openRoleManager: () => set({ showRoleManager: true }),
  closeRoleManager: () => set({ showRoleManager: false }),
  openServerSettingsModal: () => set({ showServerSettingsModal: true }),
  closeServerSettingsModal: () => set({ showServerSettingsModal: false }),
  togglePins: () => set((s) => ({ showPins: !s.showPins })),
  closePins: () => set({ showPins: false })
}))
