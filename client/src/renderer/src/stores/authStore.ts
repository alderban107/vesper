import { create } from 'zustand'
import { apiFetch, apiUpload, clearTokens, getAccessToken, setTokens } from '../api/client'
import { getLocalDeviceIdentity } from '../auth/deviceIdentity'
import { connectSocket, disconnectSocket } from '../api/socket'
import { base64ToUint8, uint8ToBase64 } from '../api/crypto'
import {
  createEncryptedKeyBundle,
  createRecoveryData,
  decryptEncryptedKeyBundle,
  decryptWithRecoveryKey,
  recoveryKeyToBytes
} from '../crypto/identity'
import { initCipherSuite, createKeyPackageBatch, encodeKeyPackageBytes } from '../crypto/mls'
import { serializePrivatePackage } from '../crypto/keySerialization'
import { clearSearchIndexSyncCredentials } from '../crypto/searchIndexSync'
import { saveIdentity, saveKeyPackages, loadIdentity, initStorage } from '../crypto/storage'
import { getMyKeyPackageCount, uploadKeyPackages } from '../api/crypto'
import { useServerStore } from './serverStore'
import { resetAllStores } from './resetStores'

interface User {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  banner_url: string | null
  status: string
}

export interface AuthDevice {
  id: string
  client_id: string
  name: string
  platform: string | null
  trust_state: 'pending' | 'trusted' | 'revoked'
  approval_method: string | null
  trusted_at: string | null
  revoked_at: string | null
  last_seen_at: string | null
  inserted_at: string
}

interface AuthResponsePayload {
  user: User
  current_device?: AuthDevice | null
  access_token?: string
  refresh_token?: string
  expires_in?: number
  encrypted_key_bundle?: string
  key_bundle_salt?: string
  key_bundle_nonce?: string
  public_identity_key?: string
  public_key_exchange?: string
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

const KEY_PACKAGE_TARGET = 20
const KEY_PACKAGE_THRESHOLD = 5

function buildSessionBody(extra: Record<string, unknown>): Record<string, unknown> {
  const device = getLocalDeviceIdentity()

  return {
    ...extra,
    device_id: device.id,
    device_name: device.name,
    device_platform: device.platform
  }
}

function parseError(data: Record<string, unknown>, fallback: string): string {
  if (data.errors && typeof data.errors === 'object') {
    return Object.entries(data.errors)
      .map(([key, value]) => `${key}: ${(value as string[]).join(', ')}`)
      .join('; ')
  }

  return typeof data.error === 'string' ? data.error : fallback
}

async function hasUnlockedLocalIdentity(userId: string): Promise<boolean> {
  const identity = await loadIdentity(userId).catch(() => null)
  return Boolean(identity?.signaturePrivateKey)
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
  const work: Array<Promise<void>> = []

  if (activeChannelId) {
    work.push(messageStore.fetchMessages(activeChannelId))
  }

  if (selectedConversationId) {
    work.push(messageStore.fetchDmMessages(selectedConversationId))
  }

  if (messageStore.activeThreadParentId) {
    work.push(messageStore.fetchThreadReplies(messageStore.activeThreadParentId))
  }

  await Promise.all(work)
}

async function resetEncryptedRuntime(): Promise<void> {
  const [{ useCryptoStore }, { useVoiceStore }] = await Promise.all([
    import('./cryptoStore'),
    import('./voiceStore')
  ])

  useCryptoStore.setState({
    groupStates: {},
    groupSetupInProgress: {},
    pendingCommits: {}
  })

  const voice = useVoiceStore.getState()
  if (voice.state !== 'idle') {
    voice.disconnect()
  }
}

function resolveCurrentDevice(
  devices: AuthDevice[],
  currentDevice: AuthDevice | null | undefined,
  fallbackCurrentDevice: AuthDevice | null
): AuthDevice | null {
  const localDeviceId = getLocalDeviceIdentity().id

  return (
    currentDevice ??
    devices.find((device) => device.client_id === localDeviceId) ??
    fallbackCurrentDevice
  )
}

async function hydrateTrustedCryptoFromPasswordResponse(
  userId: string,
  data: AuthResponsePayload,
  password: string
): Promise<boolean> {
  if (!data.encrypted_key_bundle || !data.key_bundle_nonce || !data.key_bundle_salt) {
    return false
  }

  await initCipherSuite()

  const bundle = {
    ciphertext: base64ToUint8(data.encrypted_key_bundle),
    nonce: base64ToUint8(data.key_bundle_nonce),
    salt: base64ToUint8(data.key_bundle_salt)
  }

  const privateKeys = await decryptEncryptedKeyBundle(bundle, password)
  const publicIdentityKey = data.public_identity_key
    ? base64ToUint8(data.public_identity_key)
    : bundle.ciphertext
  const publicKeyExchange = data.public_key_exchange
    ? base64ToUint8(data.public_key_exchange)
    : bundle.ciphertext

  await saveIdentity(
    userId,
    publicIdentityKey,
    publicKeyExchange,
    bundle.ciphertext,
    bundle.nonce,
    bundle.salt,
    privateKeys
  )

  return true
}

async function hydrateTrustedCryptoFromRecovery(
  userId: string,
  data: AuthResponsePayload,
  encryptedRecoveryBundle: string,
  mnemonic: string
): Promise<boolean> {
  if (!data.public_identity_key || !data.public_key_exchange) {
    return false
  }

  await initCipherSuite()

  const privateKeys = await decryptWithRecoveryKey(
    mnemonic,
    base64ToUint8(encryptedRecoveryBundle)
  )

  await saveIdentity(
    userId,
    base64ToUint8(data.public_identity_key),
    base64ToUint8(data.public_key_exchange),
    new Uint8Array(0),
    new Uint8Array(0),
    new Uint8Array(0),
    privateKeys
  )

  return true
}

async function hashRecoveryMnemonic(mnemonic: string): Promise<string> {
  const keyBytes = await recoveryKeyToBytes(mnemonic)
  const hashBuffer = await crypto.subtle.digest('SHA-256', keyBytes)

  return [...new Uint8Array(hashBuffer)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
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
      await initCipherSuite()

      const keyPackages = await createKeyPackageBatch(username, 1)
      const signaturePrivateKey = keyPackages[0].privatePackage.signaturePrivateKey
      const signaturePublicKey = keyPackages[0].publicPackage.leafNode.signaturePublicKey
      const privateKeysBundle = signaturePrivateKey
      const encryptedBundle = await createEncryptedKeyBundle(privateKeysBundle, password)
      const recoveryData = await createRecoveryData(privateKeysBundle)

      const res = await apiFetch('/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify(
          buildSessionBody({
            username,
            password,
            encrypted_key_bundle: uint8ToBase64(encryptedBundle.ciphertext),
            key_bundle_salt: uint8ToBase64(encryptedBundle.salt),
            key_bundle_nonce: uint8ToBase64(encryptedBundle.nonce),
            public_identity_key: uint8ToBase64(signaturePublicKey),
            public_key_exchange: uint8ToBase64(signaturePublicKey),
            recovery_key_hash: recoveryData.hash,
            encrypted_recovery_bundle: uint8ToBase64(recoveryData.encryptedBundle)
          })
        )
      })

      const data = (await res.json()) as Record<string, unknown> & AuthResponsePayload

      if (!res.ok) {
        set({ error: parseError(data, 'Registration failed') })
        return false
      }

      setTokens(data.access_token as string, data.refresh_token as string)
      connectSocket()
      initStorage(data.user.id)

      await saveIdentity(
        data.user.id,
        signaturePublicKey,
        signaturePublicKey,
        encryptedBundle.ciphertext,
        encryptedBundle.nonce,
        encryptedBundle.salt,
        signaturePrivateKey
      )

      const batchPairs = await createKeyPackageBatch(data.user.id, KEY_PACKAGE_TARGET, {
        signKey: signaturePrivateKey,
        publicKey: signaturePublicKey
      })

      await saveKeyPackages(
        batchPairs.map((pair) => ({
          publicData: encodeKeyPackageBytes(pair.publicPackage),
          privateData: serializePrivatePackage(pair.privatePackage)
        }))
      )

      const publicPackageBytes = batchPairs.map((pair) => encodeKeyPackageBytes(pair.publicPackage))
      await uploadKeyPackages(publicPackageBytes)

      set({
        user: data.user,
        currentDevice: data.current_device ?? null,
        devices: data.current_device ? [data.current_device] : [],
        isAuthenticated: true,
        error: null,
        recoveryMnemonic: recoveryData.mnemonic,
        canUseE2EE: true
      })

      void get().fetchDevices().catch(() => {})

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
      const res = await apiFetch('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify(buildSessionBody({ username, password }))
      })

      const data = (await res.json()) as Record<string, unknown> & AuthResponsePayload
      if (!res.ok) {
        set({ error: parseError(data, 'Login failed') })
        return false
      }

      setTokens(data.access_token as string, data.refresh_token as string)
      connectSocket()
      initStorage(data.user.id)

      let canUseE2EE = false
      if (data.current_device?.trust_state === 'trusted') {
        if (data.encrypted_key_bundle) {
          try {
            await hydrateTrustedCryptoFromPasswordResponse(data.user.id, data, password)
            canUseE2EE = true
          } catch {
            canUseE2EE = false
          }
        }

        if (!canUseE2EE) {
          canUseE2EE = await hasUnlockedLocalIdentity(data.user.id)
        }
      }

      set({
        user: data.user,
        currentDevice: data.current_device ?? null,
        devices: data.current_device ? [data.current_device] : [],
        isAuthenticated: true,
        error: null,
        canUseE2EE
      })

      if (canUseE2EE) {
        void get().replenishKeyPackages().catch(() => {})
      }

      void get().fetchDevices().catch(() => {})
      return true
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Could not connect to server'
      })
      return false
    }
  },

  logout: async () => {
    try {
      await apiFetch('/api/v1/auth/logout', { method: 'POST' })
    } catch {
      // ignore
    }

    resetAllStores()
    disconnectSocket()
    clearTokens()
    clearSearchIndexSyncCredentials()
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

  checkAuth: async () => {
    const token = getAccessToken()
    if (!token) {
      set({ isLoading: false, isAuthenticated: false, canUseE2EE: false })
      return
    }

    try {
      const res = await apiFetch('/api/v1/auth/me')
      if (!res.ok) {
        clearTokens()
        set({ isLoading: false, isAuthenticated: false, canUseE2EE: false })
        return
      }

      const data = (await res.json()) as AuthResponsePayload
      connectSocket()
      initStorage(data.user.id)

      let canUseE2EE = false
      if (data.current_device?.trust_state === 'trusted') {
        if (await hasUnlockedLocalIdentity(data.user.id)) {
          initCipherSuite().catch(() => {})
          canUseE2EE = true
        }
      }

      set({
        user: data.user,
        currentDevice: data.current_device ?? null,
        devices: data.current_device ? [data.current_device] : [],
        isAuthenticated: true,
        isLoading: false,
        canUseE2EE
      })

      if (canUseE2EE) {
        void get().replenishKeyPackages().catch(() => {})
      }

      void get().fetchDevices().catch(() => {})
    } catch {
      set({ isLoading: false, canUseE2EE: false })
    }
  },

  clearRecoveryMnemonic: () => {
    set({ recoveryMnemonic: null })
  },

  fetchDevices: async () => {
    const res = await apiFetch('/api/v1/auth/devices')
    if (!res.ok) {
      return
    }

    const data = (await res.json()) as {
      devices?: AuthDevice[]
      current_device?: AuthDevice | null
    }
    const state = get()
    const devices = data.devices ?? state.devices
    const currentDevice = resolveCurrentDevice(devices, data.current_device, state.currentDevice)
    const canUseE2EE =
      state.user && currentDevice?.trust_state === 'trusted'
        ? await hasUnlockedLocalIdentity(state.user.id)
        : false
    const wasUsingE2EE = state.canUseE2EE

    set({
      devices,
      currentDevice,
      canUseE2EE,
      error: currentDevice?.trust_state === 'trusted' ? null : state.error
    })

    if (wasUsingE2EE && !canUseE2EE) {
      await resetEncryptedRuntime()
      await refreshActiveEncryptedViews()
      return
    }

    if (!wasUsingE2EE && canUseE2EE) {
      await refreshActiveEncryptedViews()
      await get().replenishKeyPackages()
    }
  },

  approveDevice: async (deviceId) => {
    const res = await apiFetch(`/api/v1/auth/devices/${deviceId}/approve`, {
      method: 'POST'
    })
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      set({ error: parseError(data, 'Could not approve this device') })
      return false
    }

    set({ error: null })
    await get().fetchDevices()
    return true
  },

  revokeDevice: async (deviceId) => {
    const res = await apiFetch(`/api/v1/auth/devices/${deviceId}/revoke`, {
      method: 'POST'
    })
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      set({ error: parseError(data, 'Could not remove this device') })
      return false
    }

    set({ error: null })
    await get().fetchDevices()
    return true
  },

  approveCurrentDeviceWithRecovery: async (mnemonic) => {
    try {
      const recoveryKeyHash = await hashRecoveryMnemonic(mnemonic)

      const recoverRes = await apiFetch('/api/v1/auth/recover', {
        method: 'POST',
        body: JSON.stringify({ recovery_key_hash: recoveryKeyHash })
      })
      const recoverData = (await recoverRes.json()) as Record<string, unknown>

      if (!recoverRes.ok || typeof recoverData.encrypted_recovery_bundle !== 'string') {
        set({ error: parseError(recoverData, 'Recovery key was not accepted') })
        return false
      }

      const approveRes = await apiFetch('/api/v1/auth/devices/approve-with-recovery', {
        method: 'POST',
        body: JSON.stringify({ recovery_key_hash: recoveryKeyHash })
      })
      const approveData = (await approveRes.json()) as Record<string, unknown> & AuthResponsePayload

      if (!approveRes.ok) {
        set({ error: parseError(approveData, 'Could not approve this device') })
        return false
      }

      const stateRes = await apiFetch('/api/v1/auth/me')
      const stateData = (await stateRes.json()) as AuthResponsePayload

      if (!stateRes.ok) {
        set({ error: 'This device was approved, but Vesper could not finish setup.' })
        return false
      }

      const restored = await hydrateTrustedCryptoFromRecovery(
        stateData.user.id,
        stateData,
        recoverData.encrypted_recovery_bundle,
        mnemonic
      )

      if (!restored) {
        set({ error: 'This device was approved, but recovery data could not be restored.' })
        return false
      }

      set({
        user: stateData.user,
        currentDevice: approveData.current_device ?? stateData.current_device ?? null,
        canUseE2EE: true,
        error: null
      })

      await get().fetchDevices()
      await refreshActiveEncryptedViews()
      await get().replenishKeyPackages()
      return true
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Could not recover this device'
      })
      return false
    }
  },

  unlockTrustedDevice: async (password) => {
    const state = get()
    if (!state.user || state.currentDevice?.trust_state !== 'trusted') {
      set({ error: 'This device is not approved yet.' })
      return false
    }

    try {
      const res = await apiFetch('/api/v1/auth/me')
      const data = (await res.json()) as Record<string, unknown> & AuthResponsePayload

      if (!res.ok) {
        set({ error: parseError(data, 'Could not load device setup') })
        return false
      }

      const restored = await hydrateTrustedCryptoFromPasswordResponse(state.user.id, data, password)
      if (!restored) {
        set({ error: 'This device is approved, but it still needs your password to unlock encrypted chats.' })
        return false
      }

      set({
        canUseE2EE: true,
        error: null,
        currentDevice: data.current_device ?? state.currentDevice
      })
      await refreshActiveEncryptedViews()
      await get().replenishKeyPackages()
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
    const devices = [...state.devices]
    const index = devices.findIndex((entry) => entry.id === device.id)

    if (index >= 0) {
      devices[index] = device
    } else {
      devices.unshift(device)
    }

    const currentDevice = resolveCurrentDevice(
      devices,
      state.currentDevice?.id === device.id ? device : null,
      state.currentDevice
    )
    const canUseE2EE =
      state.user && currentDevice?.trust_state === 'trusted'
        ? await hasUnlockedLocalIdentity(state.user.id)
        : false

    set({
      devices,
      currentDevice,
      canUseE2EE,
      error: currentDevice?.trust_state === 'trusted' ? null : state.error
    })

    if (state.canUseE2EE && !canUseE2EE) {
      await resetEncryptedRuntime()
      await refreshActiveEncryptedViews()
      return
    }

    if (!state.canUseE2EE && canUseE2EE) {
      await refreshActiveEncryptedViews()
      await get().replenishKeyPackages()
    }
  },

  updateProfile: async (attrs) => {
    try {
      const res = await apiFetch('/api/v1/auth/profile', {
        method: 'PUT',
        body: JSON.stringify(attrs)
      })
      if (res.ok) {
        const data = await res.json()
        set({ user: data.user })
        const serverId = useServerStore.getState().activeServerId
        if (serverId) {
          useServerStore.getState().fetchMembers(serverId)
        }
        return true
      }
    } catch {
      // ignore
    }

    return false
  },

  uploadAvatar: async (file) => {
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await apiUpload('/api/v1/auth/avatar', formData)
      if (res.ok) {
        const data = await res.json()
        set({ user: data.user })
        const serverId = useServerStore.getState().activeServerId
        if (serverId) {
          useServerStore.getState().fetchMembers(serverId)
        }
        return true
      }
    } catch {
      // ignore
    }

    return false
  },

  uploadBanner: async (file) => {
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await apiUpload('/api/v1/auth/banner', formData)
      if (res.ok) {
        const data = await res.json()
        set({ user: data.user })
        const serverId = useServerStore.getState().activeServerId
        if (serverId) {
          useServerStore.getState().fetchMembers(serverId)
        }
        return true
      }
    } catch {
      // ignore
    }

    return false
  },

  replenishKeyPackages: async () => {
    const state = get()
    if (!state.user || !state.canUseE2EE) {
      return
    }

    try {
      const count = await getMyKeyPackageCount()
      if (count >= KEY_PACKAGE_THRESHOLD) {
        return
      }

      await initCipherSuite()
      const identity = await loadIdentity(state.user.id)
      if (!identity?.signaturePrivateKey) {
        return
      }

      const toGenerate = KEY_PACKAGE_TARGET - count
      const pairs = await createKeyPackageBatch(state.user.id, toGenerate, {
        signKey: identity.signaturePrivateKey,
        publicKey: identity.publicIdentityKey
      })

      const publicPackageBytes = pairs.map((pair) => encodeKeyPackageBytes(pair.publicPackage))
      await uploadKeyPackages(publicPackageBytes)

      await saveKeyPackages(
        pairs.map((pair) => ({
          publicData: encodeKeyPackageBytes(pair.publicPackage),
          privateData: serializePrivatePackage(pair.privatePackage)
        }))
      )
    } catch {
      console.warn('Failed to replenish key packages')
    }
  }
}))
