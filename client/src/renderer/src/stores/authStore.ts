import { create } from 'zustand'
import {
  type VesperAuthDevice as AuthDevice,
  type VesperAuthSession,
  type VesperUser as User
} from '@vesper/sdk/client'
import { useServerStore } from './serverStore'
import { fireAndForget } from '../utils/async'
import { resetAllStores } from './resetStores'
import { getRendererClient, getRendererEncryptedChat, resetRendererClient } from '../sdk/client'

function cacheBustAssetUrl(url: string | null | undefined): string | null {
  if (!url) {
    return null
  }

  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}v=${Date.now()}`
}

async function syncUpdatedUserCaches(user: User): Promise<void> {
  const [{ useServerStore }, { useDmStore }, { useMessageStore }] = await Promise.all([
    import('./serverStore'),
    import('./dmStore'),
    import('./messageStore')
  ])

  useServerStore.getState().updateMemberUser(user.id, {
    display_name: user.display_name,
    username: user.username,
    avatar_url: user.avatar_url
  })

  useDmStore.setState((state) => ({
    conversations: state.conversations.map((conversation) => ({
      ...conversation,
      participants: conversation.participants.map((participant) =>
        participant.user_id === user.id
          ? {
              ...participant,
              user: {
                ...participant.user,
                username: user.username,
                display_name: user.display_name,
                avatar_url: user.avatar_url,
                status: user.status
              }
            }
          : participant
      )
    }))
  }))

  useMessageStore.setState((state) => ({
    messagesByChannel: Object.fromEntries(
      Object.entries(state.messagesByChannel).map(([targetId, messages]) => [
        targetId,
        messages.map((message) =>
          message.sender_id === user.id
            ? {
                ...message,
                sender: message.sender
                  ? {
                      ...message.sender,
                      username: user.username,
                      display_name: user.display_name,
                      avatar_url: user.avatar_url
                    }
                  : {
                      id: user.id,
                      username: user.username,
                      display_name: user.display_name,
                      avatar_url: user.avatar_url
                    }
              }
            : message
        )
      ])
    )
  }))
}

interface AuthState {
  user: User | null
  currentDevice: AuthDevice | null
  devices: AuthDevice[]
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null
  recoveryMnemonic: string | null
  canUseE2EE: boolean

  register: (username: string, password: string) => Promise<boolean>
  login: (username: string, password: string) => Promise<boolean>
  verifyRecoveryKey: (mnemonic: string) => Promise<boolean>
  recoverAccount: (mnemonic: string, newPassword: string) => Promise<boolean>
  logout: () => Promise<void>
  checkAuth: () => Promise<void>
  clearRecoveryMnemonic: () => void
  replenishKeyPackages: () => Promise<void>
  updateProfile: (attrs: { display_name?: string | null; avatar_url?: string; banner_url?: string; status?: string }) => Promise<boolean>
  uploadAvatar: (file: File) => Promise<boolean>
  uploadBanner: (file: File) => Promise<boolean>
  fetchDevices: () => Promise<void>
  approveDevice: (deviceId: string) => Promise<boolean>
  revokeDevice: (deviceId: string) => Promise<boolean>
  approveCurrentDeviceWithRecovery: (mnemonic: string) => Promise<boolean>
  unlockTrustedDevice: (password: string) => Promise<boolean>
  handleDeviceEvent: (device: AuthDevice) => Promise<void>
}

function applyAuthenticatedState(
  set: (partial: Partial<AuthState>) => void,
  session: VesperAuthSession,
  overrides: Partial<AuthState> = {}
): void {
  set({
    user: session.user,
    currentDevice: session.currentDevice,
    devices: session.devices,
    isAuthenticated: true,
    error: null,
    recoveryMnemonic: session.recoveryMnemonic,
    canUseE2EE: session.canUseE2EE,
    ...overrides
  })
}

async function refreshActiveEncryptedViews(): Promise<void> {
  const [{ useMessageStore }, { useServerStore }, { useDmStore }] = await Promise.all([
    import('./messageStore'),
    import('./serverStore'),
    import('./dmStore')
  ])

  const activeChannelId = useServerStore.getState().activeChannelId
  const selectedConversationId = useDmStore.getState().selectedConversationId
  const messageStore = useMessageStore.getState()
  const encryptedChat = getRendererEncryptedChat()

  // For active DMs, re-join the channel to trigger encryption setup now that
  // E2EE may have become available (e.g. after device approval). Simply
  // re-fetching messages without the group ready will leave them as "syncing".
  if (selectedConversationId) {
    if (!encryptedChat.hasGroup(selectedConversationId)) {
      // Leave and rejoin to re-trigger the encryption bootstrap flow
      messageStore.leaveDmChat(selectedConversationId)
      messageStore.joinDmChat(selectedConversationId)
      // joinDmChat handles fetching messages internally, so skip manual fetch
    } else {
      await messageStore.fetchDmMessages(selectedConversationId)
    }
  }

  if (activeChannelId) {
    if (!encryptedChat.hasGroup(activeChannelId)) {
      messageStore.leaveChannelChat(activeChannelId)
      messageStore.joinChannelChat(activeChannelId)
    } else {
      await messageStore.fetchMessages(activeChannelId)
    }
  }

  if (messageStore.activeThreadParentId) {
    await messageStore.fetchThreadReplies(messageStore.activeThreadParentId)
  }
}

async function resetEncryptedRuntime(): Promise<void> {
  const { useVoiceStore } = await import('./voiceStore')
  getRendererEncryptedChat().reset()

  const voice = useVoiceStore.getState()
  if (voice.state !== 'idle') {
    voice.disconnect()
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  currentDevice: null,
  devices: [],
  isAuthenticated: false,
  isLoading: true,
  error: null,
  recoveryMnemonic: null,
  canUseE2EE: false,

  register: async (username, password) => {
    set({ error: null })

    try {
      const session = await getRendererClient().register(username, password)
      applyAuthenticatedState(set, session)
      fireAndForget(getRendererClient().start(false))
      fireAndForget(get().fetchDevices())

      return true
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Could not connect to server'
      })
      return false
    }
  },

  login: async (username, password) => {
    set({ error: null })

    try {
      const session = await getRendererClient().login(username, password)
      applyAuthenticatedState(set, session, { recoveryMnemonic: null })
      fireAndForget(getRendererClient().start(false))
      if (session.canUseE2EE) {
        fireAndForget(get().replenishKeyPackages())
        fireAndForget(refreshActiveEncryptedViews())
      }

      fireAndForget(get().fetchDevices())
      return true
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Could not connect to server'
      })
      return false
    }
  },

  logout: async () => {
    await getRendererClient().logout()
    resetRendererClient()
    resetAllStores()
    set({
      user: null,
      currentDevice: null,
      devices: [],
      isAuthenticated: false,
      error: null,
      recoveryMnemonic: null,
      canUseE2EE: false
    })
  },

  verifyRecoveryKey: async (mnemonic) => {
    set({ error: null })

    try {
      await getRendererClient().verifyRecoveryKey(mnemonic)
      return true
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Invalid recovery key'
      })
      return false
    }
  },

  recoverAccount: async (mnemonic, newPassword) => {
    set({ error: null })

    try {
      const session = await getRendererClient().recoverAccount(mnemonic, newPassword)
      applyAuthenticatedState(set, session, { recoveryMnemonic: null })
      fireAndForget(getRendererClient().start(false))

      if (session.canUseE2EE) {
        fireAndForget(get().replenishKeyPackages())
        fireAndForget(refreshActiveEncryptedViews())
      }

      fireAndForget(get().fetchDevices())
      return true
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Could not recover this account'
      })
      return false
    }
  },

  checkAuth: async () => {
    try {
      const session = await getRendererClient().restoreSession()
      if (!session) {
        set({ isLoading: false, isAuthenticated: false, canUseE2EE: false })
        return
      }

      applyAuthenticatedState(set, session, { isLoading: false, recoveryMnemonic: null })
      fireAndForget(getRendererClient().start(true))
      if (session.canUseE2EE) {
        fireAndForget(get().replenishKeyPackages())
        fireAndForget(refreshActiveEncryptedViews())
      }

      fireAndForget(get().fetchDevices())
    } catch {
      set({ isLoading: false, canUseE2EE: false })
    }
  },

  clearRecoveryMnemonic: () => {
    set({ recoveryMnemonic: null })
  },

  fetchDevices: async () => {
    const state = get()
    const nextState = await getRendererClient().fetchDevices()
    const wasUsingE2EE = state.canUseE2EE

    set({
      devices: nextState.devices,
      currentDevice: nextState.currentDevice,
      canUseE2EE: nextState.canUseE2EE,
      error: nextState.currentDevice?.trust_state === 'trusted' ? null : state.error
    })

    if (wasUsingE2EE && !nextState.canUseE2EE) {
      await resetEncryptedRuntime()
      await refreshActiveEncryptedViews()
      return
    }

    if (!wasUsingE2EE && nextState.canUseE2EE) {
      await get().replenishKeyPackages()
      await refreshActiveEncryptedViews()
    }
  },

  approveDevice: async (deviceId) => {
    try {
      await getRendererClient().approveDevice(deviceId)
      set({ error: null })
      await get().fetchDevices()
      return true
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Could not approve this device' })
      return false
    }
  },

  revokeDevice: async (deviceId) => {
    try {
      await getRendererClient().revokeDevice(deviceId)
      set({ error: null })
      await get().fetchDevices()
      return true
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Could not remove this device' })
      return false
    }
  },

  approveCurrentDeviceWithRecovery: async (mnemonic) => {
    try {
      await getRendererClient().approveCurrentDeviceWithRecovery(mnemonic)
      const session = getRendererClient().getAuthSession()
      if (!session) {
        throw new Error('Device approval did not produce a session')
      }
      applyAuthenticatedState(set, session, { recoveryMnemonic: null })
      fireAndForget(getRendererClient().start(false))
      await get().fetchDevices()
      await get().replenishKeyPackages()
      await refreshActiveEncryptedViews()
      return true
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Could not recover this device'
      })
      return false
    }
  },

  unlockTrustedDevice: async (password) => {
    try {
      if (!get().user) {
        set({ error: 'This device is not approved yet.' })
        return false
      }

      await getRendererClient().unlockTrustedDevice(password)
      const session = getRendererClient().getAuthSession()
      if (!session) {
        throw new Error('Trusted device unlock did not produce a session')
      }
      applyAuthenticatedState(set, session, { recoveryMnemonic: null })
      fireAndForget(getRendererClient().start(false))
      await get().replenishKeyPackages()
      await refreshActiveEncryptedViews()
      return true
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Could not unlock encrypted chats on this device'
      })
      return false
    }
  },

  handleDeviceEvent: async (device) => {
    const state = get()
    const existingCurrentDevice = state.currentDevice
    const currentDeviceUpdated = existingCurrentDevice?.id === device.id
    const nextCurrentDevice = currentDeviceUpdated ? device : existingCurrentDevice
    const nextCanUseE2EE =
      nextCurrentDevice?.trust_state === 'trusted' ? state.canUseE2EE : false

    set({
      devices: [
        device,
        ...state.devices.filter((entry) => entry.id !== device.id)
      ],
      currentDevice: nextCurrentDevice,
      canUseE2EE: nextCanUseE2EE,
      error: nextCurrentDevice?.trust_state === 'trusted' ? null : state.error
    })

    if (state.canUseE2EE && !nextCanUseE2EE) {
      await resetEncryptedRuntime()
      await refreshActiveEncryptedViews()
    }
  },

  updateProfile: async (attrs) => {
    try {
      const user = await getRendererClient().updateProfile(attrs)
      set({ user })
      await syncUpdatedUserCaches(user)
      const serverId = useServerStore.getState().activeServerId
      if (serverId) {
        useServerStore.getState().fetchMembers(serverId)
      }
      return true
    } catch {
      return false
    }
  },

  uploadAvatar: async (file) => {
    try {
      const user = await getRendererClient().uploadAvatar(file)
      const nextUser = {
        ...user,
        avatar_url: cacheBustAssetUrl(user.avatar_url)
      }
      set({ user: nextUser })
      await syncUpdatedUserCaches(nextUser)
      const serverId = useServerStore.getState().activeServerId
      if (serverId) {
        useServerStore.getState().fetchMembers(serverId)
      }
      return true
    } catch {
      return false
    }
  },

  uploadBanner: async (file) => {
    try {
      const user = await getRendererClient().uploadBanner(file)
      const nextUser = {
        ...user,
        banner_url: cacheBustAssetUrl(user.banner_url)
      }
      set({ user: nextUser })
      await syncUpdatedUserCaches(nextUser)
      const serverId = useServerStore.getState().activeServerId
      if (serverId) {
        useServerStore.getState().fetchMembers(serverId)
      }
      return true
    } catch {
      return false
    }
  },

  replenishKeyPackages: async () => {
    await getRendererClient().replenishKeyPackages()
  }
}))
