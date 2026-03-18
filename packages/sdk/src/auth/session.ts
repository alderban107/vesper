import { type LocalDeviceIdentity, getLocalDeviceIdentity } from './deviceIdentity.js'
import {
  base64ToUint8,
  getMyKeyPackageCount,
  purgeMyKeyPackages,
  uint8ToBase64,
  uploadKeyPackages
} from '../api/crypto.js'
import {
  apiFetch,
  apiUpload,
  clearTokens,
  getAccessToken,
  getRefreshToken,
  setTokens
} from '../api/client.js'
import { connectSocket, disconnectSocket } from '../api/socket.js'
import { clearSearchIndexSyncCredentials } from '../crypto/searchIndexSync.js'
import {
  createEncryptedKeyBundle,
  createRecoveryData,
  decryptEncryptedKeyBundle,
  decryptWithRecoveryKey,
  initStorage,
  loadIdentity,
  loadKeyPackages,
  recoveryKeyToBytes,
  saveIdentity,
  saveKeyPackages,
  serializePrivatePackage
} from '../crypto/index.js'
import {
  buildClientCredentialIdentity,
  createKeyPackageBatch,
  encodeKeyPackageBytes,
  initCipherSuite
} from '../crypto/mls.js'

export interface VesperUser {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  banner_url: string | null
  status: string
}

export interface VesperAuthDevice {
  id: string
  client_id: string
  name: string
  platform: string | null
  trust_state: 'pending' | 'trusted' | 'revoked'
  approval_method: string | null
  trusted_at: string | null
  revoked_at: string | null
  last_seen_at: string | null
  push_token?: string | null
  push_platform?: string | null
  background_sync_capable?: boolean
  notification_public_key?: string | null
  inserted_at: string
}

interface AuthResponsePayload {
  user: VesperUser
  current_device?: VesperAuthDevice | null
  access_token?: string
  refresh_token?: string
  expires_in?: number
  encrypted_key_bundle?: string
  key_bundle_salt?: string
  key_bundle_nonce?: string
  public_identity_key?: string
  public_key_exchange?: string
}

export interface VesperAuthSession {
  user: VesperUser
  currentDevice: VesperAuthDevice | null
  devices: VesperAuthDevice[]
  canUseE2EE: boolean
  recoveryMnemonic: string | null
}

export interface DeviceListState {
  devices: VesperAuthDevice[]
  currentDevice: VesperAuthDevice | null
  canUseE2EE: boolean
}

export interface VesperAuthClientOptions {
  getDeviceIdentity?: () => LocalDeviceIdentity
}

const KEY_PACKAGE_TARGET = 20
const KEY_PACKAGE_THRESHOLD = 5

export class VesperAuthClient {
  private readonly resolveDeviceIdentity: () => LocalDeviceIdentity
  private keyPackageReplenishPromise: Promise<void> | null = null

  constructor(options: VesperAuthClientOptions = {}) {
    this.resolveDeviceIdentity = options.getDeviceIdentity ?? getLocalDeviceIdentity
  }

  async register(username: string, password: string): Promise<VesperAuthSession> {
    await initCipherSuite()

    const keyPackages = await createKeyPackageBatch(username, 1)
    const signaturePrivateKey = keyPackages[0].privatePackage.signaturePrivateKey
    const signaturePublicKey = keyPackages[0].publicPackage.leafNode.signaturePublicKey
    const encryptedBundle = await createEncryptedKeyBundle(signaturePrivateKey, password)
    const recoveryData = await createRecoveryData(signaturePrivateKey)

    const response = await apiFetch('/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify(
        this.buildSessionBody({
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

    const data = (await response.json()) as Record<string, unknown> & AuthResponsePayload
    if (!response.ok) {
      throw new Error(parseError(data, 'Registration failed'))
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

    const batchPairs = await createKeyPackageBatch(
      this.getCurrentMlsCredentialIdentity(data.user.id),
      KEY_PACKAGE_TARGET,
      {
        signKey: signaturePrivateKey,
        publicKey: signaturePublicKey
      }
    )

    await saveKeyPackages(
      batchPairs.map((pair) => ({
        publicData: encodeKeyPackageBytes(pair.publicPackage),
        privateData: serializePrivatePackage(pair.privatePackage)
      }))
    )

    const publicPackageBytes = batchPairs.map((pair) => encodeKeyPackageBytes(pair.publicPackage))
    await uploadKeyPackages(publicPackageBytes, this.resolveDeviceIdentity().id)

    void this.registerCurrentDeviceNotificationCapability()

    return {
      user: data.user,
      currentDevice: data.current_device ?? null,
      devices: data.current_device ? [data.current_device] : [],
      canUseE2EE: true,
      recoveryMnemonic: recoveryData.mnemonic
    }
  }

  async login(username: string, password: string): Promise<VesperAuthSession> {
    const response = await apiFetch('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify(this.buildSessionBody({ username, password }))
    })

    const data = (await response.json()) as Record<string, unknown> & AuthResponsePayload
    if (!response.ok) {
      throw new Error(parseError(data, 'Login failed'))
    }

    setTokens(data.access_token as string, data.refresh_token as string)
    connectSocket()
    initStorage(data.user.id)

    let canUseE2EE = false
    if (data.current_device?.trust_state === 'trusted') {
      canUseE2EE = await hasUnlockedLocalIdentity(data.user.id)

      if (!canUseE2EE && shouldGenerateFreshDeviceIdentity(data.current_device)) {
        canUseE2EE = await this.createFreshLocalDeviceIdentity(data.user.id).catch(() => false)
      }

      if (!canUseE2EE && data.encrypted_key_bundle) {
        canUseE2EE = await hydrateTrustedCryptoFromPasswordResponse(
          data.user.id,
          data,
          password
        ).catch(() => false)
      }
    }

    void this.registerCurrentDeviceNotificationCapability()

    return {
      user: data.user,
      currentDevice: data.current_device ?? null,
      devices: data.current_device ? [data.current_device] : [],
      canUseE2EE,
      recoveryMnemonic: null
    }
  }

  async checkAuth(): Promise<VesperAuthSession | null> {
    const token = getAccessToken()
    if (!token) {
      return null
    }

    const response = await apiFetch('/api/v1/auth/me')
    if (!response.ok) {
      clearTokens()
      return null
    }

    const data = (await response.json()) as AuthResponsePayload
    connectSocket()
    initStorage(data.user.id)

    let canUseE2EE = false
    if (
      data.current_device?.trust_state === 'trusted' &&
      (await hasUnlockedLocalIdentity(data.user.id))
    ) {
      void initCipherSuite().catch(() => {})
      canUseE2EE = true
    }

    void this.registerCurrentDeviceNotificationCapability()

    return {
      user: data.user,
      currentDevice: data.current_device ?? null,
      devices: data.current_device ? [data.current_device] : [],
      canUseE2EE,
      recoveryMnemonic: null
    }
  }

  async logout(): Promise<void> {
    try {
      await apiFetch('/api/v1/auth/logout', { method: 'POST' })
    } catch {
      // Ignore logout transport failures.
    }

    disconnectSocket()
    clearTokens()
    clearSearchIndexSyncCredentials()
  }

  async verifyRecoveryKey(mnemonic: string): Promise<void> {
    const recoveryKeyHash = await hashRecoveryMnemonic(mnemonic)
    const response = await apiFetch('/api/v1/auth/recover', {
      method: 'POST',
      body: JSON.stringify({ recovery_key_hash: recoveryKeyHash })
    })

    const data = (await response.json()) as Record<string, unknown>
    if (!response.ok || typeof data.encrypted_recovery_bundle !== 'string') {
      throw new Error(parseError(data, 'Invalid recovery key'))
    }

    const encryptedBundle = base64ToUint8(data.encrypted_recovery_bundle)
    await decryptWithRecoveryKey(mnemonic, encryptedBundle)
  }

  async fetchDevices(params: {
    devices: VesperAuthDevice[]
    currentDevice: VesperAuthDevice | null
    user: VesperUser | null
  }): Promise<DeviceListState> {
    const response = await apiFetch('/api/v1/auth/devices')
    if (!response.ok) {
      return {
        devices: params.devices,
        currentDevice: params.currentDevice,
        canUseE2EE:
          params.user && params.currentDevice?.trust_state === 'trusted'
            ? await hasUnlockedLocalIdentity(params.user.id)
            : false
      }
    }

    const data = (await response.json()) as {
      devices?: VesperAuthDevice[]
      current_device?: VesperAuthDevice | null
    }
    const devices = data.devices ?? params.devices
    const currentDevice = resolveCurrentDevice(
      devices,
      data.current_device,
      params.currentDevice,
      this.resolveDeviceIdentity
    )
    const canUseE2EE =
      params.user && currentDevice?.trust_state === 'trusted'
        ? await hasUnlockedLocalIdentity(params.user.id)
        : false

    return {
      devices,
      currentDevice,
      canUseE2EE
    }
  }

  async approveDevice(deviceId: string): Promise<void> {
    const response = await apiFetch(`/api/v1/auth/devices/${deviceId}/approve`, {
      method: 'POST'
    })

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
      throw new Error(parseError(data, 'Could not approve this device'))
    }
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const response = await apiFetch(`/api/v1/auth/devices/${deviceId}/revoke`, {
      method: 'POST'
    })

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
      throw new Error(parseError(data, 'Could not remove this device'))
    }
  }

  async approveCurrentDeviceWithRecovery(mnemonic: string): Promise<VesperAuthSession> {
    const recoveryKeyHash = await hashRecoveryMnemonic(mnemonic)

    const recoverResponse = await apiFetch('/api/v1/auth/recover', {
      method: 'POST',
      body: JSON.stringify({ recovery_key_hash: recoveryKeyHash })
    })
    const recoverData = (await recoverResponse.json()) as Record<string, unknown>

    if (!recoverResponse.ok || typeof recoverData.encrypted_recovery_bundle !== 'string') {
      throw new Error(parseError(recoverData, 'Recovery key was not accepted'))
    }

    const approveResponse = await apiFetch('/api/v1/auth/devices/approve-with-recovery', {
      method: 'POST',
      body: JSON.stringify({ recovery_key_hash: recoveryKeyHash })
    })
    const approveData = (await approveResponse.json()) as Record<string, unknown> & AuthResponsePayload

    if (!approveResponse.ok) {
      throw new Error(parseError(approveData, 'Could not approve this device'))
    }

    let refreshedTokensApplied = false
    if (approveData.access_token && approveData.refresh_token) {
      setTokens(approveData.access_token, approveData.refresh_token)
      refreshedTokensApplied = true
    } else {
      const refreshToken = getRefreshToken()
      if (refreshToken) {
        const refreshResponse = await apiFetch('/api/v1/auth/refresh', {
          method: 'POST',
          body: JSON.stringify({ refresh_token: refreshToken })
        })
        const refreshData = (await refreshResponse.json()) as AuthResponsePayload

        if (refreshResponse.ok && refreshData.access_token && refreshData.refresh_token) {
          setTokens(refreshData.access_token, refreshData.refresh_token)
          refreshedTokensApplied = true
        }
      }
    }

    if (refreshedTokensApplied) {
      disconnectSocket()
      connectSocket()
    }

    const session = await this.requireCurrentSession(
      'This device was approved, but Vesper could not finish setup.'
    )

    const restored = await this.createFreshLocalDeviceIdentity(session.user.id)
    if (!restored) {
      throw new Error('This device was approved, but encrypted chat setup could not be completed.')
    }

    return {
      ...session,
      currentDevice: approveData.current_device ?? session.currentDevice,
      canUseE2EE: true
    }
  }

  async unlockTrustedDevice(
    user: VesperUser,
    currentDevice: VesperAuthDevice | null,
    password: string
  ): Promise<VesperAuthSession> {
    if (currentDevice?.trust_state !== 'trusted') {
      throw new Error('This device is not approved yet.')
    }

    const response = await apiFetch('/api/v1/auth/me')
    const data = (await response.json()) as Record<string, unknown> & AuthResponsePayload

    if (!response.ok) {
      throw new Error(parseError(data, 'Could not load device setup'))
    }

    const restored =
      (await hasUnlockedLocalIdentity(user.id)) ||
      (shouldGenerateFreshDeviceIdentity(data.current_device) &&
        (await this.createFreshLocalDeviceIdentity(user.id))) ||
      (await hydrateTrustedCryptoFromPasswordResponse(user.id, data, password))

    if (!restored) {
      throw new Error(
        'This device is approved, but it still needs your password to unlock encrypted chats.'
      )
    }

    return {
      user,
      currentDevice: data.current_device ?? currentDevice,
      devices: data.current_device ? [data.current_device] : currentDevice ? [currentDevice] : [],
      canUseE2EE: true,
      recoveryMnemonic: null
    }
  }

  async recoverAccount(mnemonic: string, newPassword: string): Promise<VesperAuthSession> {
    const recoveryKeyHash = await hashRecoveryMnemonic(mnemonic)
    const response = await apiFetch('/api/v1/auth/recover', {
      method: 'POST',
      body: JSON.stringify({ recovery_key_hash: recoveryKeyHash })
    })

    const data = (await response.json()) as Record<string, unknown>
    if (!response.ok || typeof data.encrypted_recovery_bundle !== 'string') {
      throw new Error(parseError(data, 'Invalid recovery key'))
    }

    const encryptedBundle = base64ToUint8(data.encrypted_recovery_bundle)
    const privateKeys = await decryptWithRecoveryKey(mnemonic, encryptedBundle)
    const newBundle = await createEncryptedKeyBundle(privateKeys, newPassword)
    const device = this.resolveDeviceIdentity()

    const resetResponse = await apiFetch('/api/v1/auth/recover/reset', {
      method: 'POST',
      body: JSON.stringify({
        recovery_key_hash: recoveryKeyHash,
        new_password: newPassword,
        device_id: device.id,
        device_name: device.name,
        device_platform: device.platform,
        encrypted_key_bundle: uint8ToBase64(newBundle.ciphertext),
        key_bundle_nonce: uint8ToBase64(newBundle.nonce),
        key_bundle_salt: uint8ToBase64(newBundle.salt)
      })
    })

    const resetData = (await resetResponse.json()) as Record<string, unknown> & AuthResponsePayload
    if (!resetResponse.ok) {
      throw new Error(parseError(resetData, 'Failed to reset password'))
    }

    setTokens(resetData.access_token as string, resetData.refresh_token as string)
    connectSocket()
    initStorage(resetData.user.id)

    await saveIdentity(
      resetData.user.id,
      resetData.public_identity_key
        ? base64ToUint8(resetData.public_identity_key)
        : new Uint8Array(0),
      resetData.public_key_exchange
        ? base64ToUint8(resetData.public_key_exchange)
        : new Uint8Array(0),
      newBundle.ciphertext,
      newBundle.nonce,
      newBundle.salt,
      privateKeys
    )

    void this.registerCurrentDeviceNotificationCapability()

    return {
      user: resetData.user,
      currentDevice: resetData.current_device ?? null,
      devices: resetData.current_device ? [resetData.current_device] : [],
      canUseE2EE: true,
      recoveryMnemonic: null
    }
  }

  async updateProfile(attrs: {
    display_name?: string | null
    avatar_url?: string
    banner_url?: string
    status?: string
  }): Promise<VesperUser> {
    const response = await apiFetch('/api/v1/auth/profile', {
      method: 'PUT',
      body: JSON.stringify(attrs)
    })
    if (!response.ok) {
      throw new Error('Could not update profile')
    }

    const data = (await response.json()) as { user: VesperUser }
    return data.user
  }

  async uploadAvatar(file: File): Promise<VesperUser> {
    const formData = new FormData()
    formData.append('file', file)

    const response = await apiUpload('/api/v1/auth/avatar', formData)
    if (!response.ok) {
      throw new Error('Could not upload avatar')
    }

    const data = (await response.json()) as { user: VesperUser }
    return data.user
  }

  async uploadBanner(file: File): Promise<VesperUser> {
    const formData = new FormData()
    formData.append('file', file)

    const response = await apiUpload('/api/v1/auth/banner', formData)
    if (!response.ok) {
      throw new Error('Could not upload banner')
    }

    const data = (await response.json()) as { user: VesperUser }
    return data.user
  }

  async replenishKeyPackages(user: VesperUser | null, canUseE2EE: boolean): Promise<void> {
    if (this.keyPackageReplenishPromise) {
      return this.keyPackageReplenishPromise
    }

    this.keyPackageReplenishPromise = (async () => {
      if (!user || !canUseE2EE) {
        return
      }

      try {
        const localPackages = await loadKeyPackages()
        if (localPackages.length === 0) {
          await purgeMyKeyPackages(this.resolveDeviceIdentity().id)
        }

        const count = await getMyKeyPackageCount(this.resolveDeviceIdentity().id)
        if (count >= KEY_PACKAGE_THRESHOLD) {
          return
        }

        await initCipherSuite()
        const identity = await loadIdentity(user.id)
        if (!identity?.signaturePrivateKey) {
          return
        }

        const pairs = await createKeyPackageBatch(
          this.getCurrentMlsCredentialIdentity(user.id),
          KEY_PACKAGE_TARGET - count,
          {
            signKey: identity.signaturePrivateKey,
            publicKey: identity.publicIdentityKey
          }
        )

        await saveKeyPackages(
          pairs.map((pair) => ({
            publicData: encodeKeyPackageBytes(pair.publicPackage),
            privateData: serializePrivatePackage(pair.privatePackage)
          }))
        )

        const publicPackageBytes = pairs.map((pair) => encodeKeyPackageBytes(pair.publicPackage))
        await uploadKeyPackages(publicPackageBytes, this.resolveDeviceIdentity().id)
      } finally {
        this.keyPackageReplenishPromise = null
      }
    })()

    return this.keyPackageReplenishPromise
  }

  private buildSessionBody(extra: Record<string, unknown>): Record<string, unknown> {
    const device = this.resolveDeviceIdentity()

    return {
      ...extra,
      device_id: device.id,
      device_name: device.name,
      device_platform: device.platform
    }
  }

  private getCurrentMlsCredentialIdentity(userId: string): string {
    return buildClientCredentialIdentity(userId, this.resolveDeviceIdentity().id)
  }

  private async createFreshLocalDeviceIdentity(userId: string): Promise<boolean> {
    await initCipherSuite()

    const pairs = await createKeyPackageBatch(this.getCurrentMlsCredentialIdentity(userId), 1)
    const signaturePrivateKey = pairs[0]?.privatePackage.signaturePrivateKey
    const signaturePublicKey = pairs[0]?.publicPackage.leafNode.signaturePublicKey

    if (!signaturePrivateKey || !signaturePublicKey) {
      return false
    }

    await saveIdentity(
      userId,
      signaturePublicKey,
      signaturePublicKey,
      new Uint8Array(0),
      new Uint8Array(0),
      new Uint8Array(0),
      signaturePrivateKey
    )

    return true
  }

  private async registerCurrentDeviceNotificationCapability(): Promise<void> {
    try {
      await apiFetch('/api/v1/auth/devices/current/notifications', {
        method: 'PUT',
        body: JSON.stringify({
          push_platform:
            typeof window !== 'undefined' && 'electron' in window ? 'electron' : 'web',
          background_sync_capable: true
        })
      })
    } catch {
      // Ignore capability registration failures.
    }
  }

  private async requireCurrentSession(errorMessage: string): Promise<VesperAuthSession> {
    const sessionResponse = await this.checkAuth()
    if (!sessionResponse) {
      throw new Error(errorMessage)
    }

    return sessionResponse
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

function resolveCurrentDevice(
  devices: VesperAuthDevice[],
  currentDevice: VesperAuthDevice | null | undefined,
  fallbackCurrentDevice: VesperAuthDevice | null,
  resolveDeviceIdentity: () => LocalDeviceIdentity
): VesperAuthDevice | null {
  const localDeviceId = resolveDeviceIdentity().id

  return (
    currentDevice ??
    devices.find((device) => device.client_id === localDeviceId) ??
    fallbackCurrentDevice
  )
}

function shouldGenerateFreshDeviceIdentity(
  currentDevice: VesperAuthDevice | null | undefined
): boolean {
  return Boolean(currentDevice?.approval_method)
}

async function hasUnlockedLocalIdentity(userId: string): Promise<boolean> {
  const identity = await loadIdentity(userId).catch(() => null)
  return Boolean(identity?.signaturePrivateKey)
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

async function hashRecoveryMnemonic(mnemonic: string): Promise<string> {
  const keyBytes = await recoveryKeyToBytes(mnemonic)
  const hashBuffer = await crypto.subtle.digest('SHA-256', keyBytes as unknown as BufferSource)

  return [...new Uint8Array(hashBuffer)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}
