import { create } from 'zustand'

interface UIState {
  showCreateServerModal: boolean
  showJoinServerModal: boolean
  showCreateChannelModal: boolean
  showNewDmModal: boolean
  showSettingsModal: boolean
  showRoleManager: boolean
  showServerSettingsModal: boolean
  showChannelSettingsModal: boolean
  channelSettingsChannelId: string | null
  showPins: boolean
  showMemberList: boolean
  showMobileNav: boolean
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
  openChannelSettingsModal: (channelId: string) => void
  closeChannelSettingsModal: () => void
  togglePins: () => void
  closePins: () => void
  toggleMemberList: () => void
  setMemberListVisible: (visible: boolean) => void
  openMobileNav: () => void
  closeMobileNav: () => void
  toggleMobileNav: () => void
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
  showChannelSettingsModal: false,
  channelSettingsChannelId: null,
  showPins: false,
  showMemberList: true,
  showMobileNav: false,
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
  openChannelSettingsModal: (channelId) =>
    set({ showChannelSettingsModal: true, channelSettingsChannelId: channelId }),
  closeChannelSettingsModal: () =>
    set({ showChannelSettingsModal: false, channelSettingsChannelId: null }),
  togglePins: () => set((s) => ({ showPins: !s.showPins })),
  closePins: () => set({ showPins: false }),
  toggleMemberList: () => set((s) => ({ showMemberList: !s.showMemberList })),
  setMemberListVisible: (visible) => set({ showMemberList: visible }),
  openMobileNav: () => set({ showMobileNav: true }),
  closeMobileNav: () => set({ showMobileNav: false }),
  toggleMobileNav: () => set((s) => ({ showMobileNav: !s.showMobileNav })),
  setChannelSidebarWidth: (width) => set({ channelSidebarWidth: Math.max(220, Math.min(360, width)) }),
  setMemberListWidth: (width) => set({ memberListWidth: Math.max(220, Math.min(420, width)) })
}))
