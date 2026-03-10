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
  showMemberList: boolean
  channelSidebarWidth: number
  memberListWidth: number

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
  toggleMemberList: () => void
  setMemberListVisible: (visible: boolean) => void
  setChannelSidebarWidth: (width: number) => void
  setMemberListWidth: (width: number) => void
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
  showMemberList: true,
  channelSidebarWidth: 248,
  memberListWidth: 264,

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
  closePins: () => set({ showPins: false }),
  toggleMemberList: () => set((s) => ({ showMemberList: !s.showMemberList })),
  setMemberListVisible: (visible) => set({ showMemberList: visible }),
  setChannelSidebarWidth: (width) => set({ channelSidebarWidth: Math.max(220, Math.min(360, width)) }),
  setMemberListWidth: (width) => set({ memberListWidth: Math.max(220, Math.min(420, width)) })
}))
