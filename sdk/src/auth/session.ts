import { type LocalDeviceIdentity, getLocalDeviceIdentity } from './deviceIdentity.js'
import {
  base64ToUint8,
  getMyKeyPackageCount,
  purgeMyKeyPackages,
  uint8ToBase64,
  uploadKeyPackages
} from '../api/crypto.js'
import {
  getDefaultHttpClient,
  type SessionStore,
  VesperHttpClient
} from '../api/client.js'
import { getDefaultSocketClient, VesperSocketClient } from '../api/socket.js'
import { clearSearchIndexSyncCredentials } from '../crypto/searchIndexSync.js'
import {
  createEncryptedKeyBundle,
  createRecoveryData,
  decryptEncryptedKeyBundle,
  decryptWithRecoveryKey,
  recoveryKeyToBytes,
} from '../crypto/index.js'
import {
  createCryptoStorageRuntime,
  type CryptoStorageConfig,
  type CryptoStorageRuntime
} from '../crypto/storage.js'
import {
  buildClientCredentialIdentity,
  buildIdentityData,
  createKeyPackageBatch,
  createSigningIdentity,
  initCipherSuite
} from '../crypto/mls.js'
import type { VesperTransport } from '../transport/context.js'

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
  fetchImpl?: typeof fetch
  sessionStore?: SessionStore
  httpClient?: VesperHttpClient
  socketClient?: VesperSocketClient
  transport?: Pick<VesperTransport, 'httpClient' | 'socketClient'>
  storage?: CryptoStorageConfig
  storageRuntime?: CryptoStorageRuntime
}

const KEY_PACKAGE_TARGET = 20
const KEY_PACKAGE_THRESHOLD = 5

export class VesperAuthClient {
  private readonly resolveDeviceIdentity: () => LocalDeviceIdentity
  private readonly httpClient: VesperHttpClient
  private readonly socketClient: VesperSocketClient
  private readonly storage: CryptoStorageRuntime
  private lastKnownUserId: string | null = null
  private keyPackageReplenishPromise: Promise<void> | null = null

  constructor(options: VesperAuthClientOptions = {}) {
    this.storage = options.storageRuntime ?? createCryptoStorageRuntime(options.storage)
    this.resolveDeviceIdentity = options.getDeviceIdentity ?? getLocalDeviceIdentity
    this.httpClient =
      options.transport?.httpClient ??
      options.httpClient ??
      (options.sessionStore || options.fetchImpl
        ? new VesperHttpClient({
            fetchImpl: options.fetchImpl,
            sessionStore: options.sessionStore
          })
        : getDefaultHttpClient())
    this.socketClient =
      options.transport?.socketClient ??
      options.socketClient ??
      (options.sessionStore || options.fetchImpl
        ? new VesperSocketClient({
            getAccessToken: () => this.httpClient.getAccessToken(),
            getServerUrl: () => this.httpClient.getServerUrl()
          })
        : getDefaultSocketClient())
  }

  async register(username: string, password: string): Promise<VesperAuthSession> {
    return await this.withStorageContext(null, async () => {
      await initCipherSuite()

      // Create the signing identity — generates Ed25519 keypair inside OpenMLS
      const signingIdentity = await createSigningIdentity(username)
      const signaturePublicKey = signingIdentity.signaturePublicKey
      // The "private key" is the serialized Provider storage containing the Ed25519 private key
      const signaturePrivateKey = signingIdentity.privateKeyBundle
      const encryptedBundle = await createEncryptedKeyBundle(signaturePrivateKey, password)
      const recoveryData = await createRecoveryData(signaturePrivateKey)

      const response = await this.httpClient.apiFetch('/api/v1/auth/register', {
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

      this.httpClient.setTokens(data.access_token as string, data.refresh_token as string)
      this.storage.init(data.user.id)
      this.lastKnownUserId = data.user.id

      await this.storage.saveIdentity(
        data.user.id,
        signaturePublicKey,
        signaturePublicKey,
        encryptedBundle.ciphertext,
        encryptedBundle.nonce,
        encryptedBundle.salt,
        signaturePrivateKey
      )

      const batchPairs = await createKeyPackageBatch(
        signingIdentity.identityData,
        signingIdentity.privateKeyBundle,
        KEY_PACKAGE_TARGET,
      )

      await this.storage.saveKeyPackages(
        batchPairs.map((pair) => ({
          publicData: pair.publicData,
          privateData: pair.privateData
        }))
      )

      const publicPackageBytes = batchPairs.map((pair) => pair.publicData)
      await uploadKeyPackages(publicPackageBytes, this.resolveDeviceIdentity().id, this.httpClient)

      void this.registerCurrentDeviceNotificationCapability()

      return {
        user: data.user,
        currentDevice: data.current_device ?? null,
        devices: data.current_device ? [data.current_device] : [],
        canUseE2EE: true,
        recoveryMnemonic: recoveryData.mnemonic
      }
    })
  }

  async login(username: string, password: string): Promise<VesperAuthSession> {
    return await this.withStorageContext(null, async () => {
      const response = await this.httpClient.apiFetch('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify(this.buildSessionBody({ username, password }))
      })

      const data = (await response.json()) as Record<string, unknown> & AuthResponsePayload
      if (!response.ok) {
        throw new Error(parseError(data, 'Login failed'))
      }

      this.httpClient.setTokens(data.access_token as string, data.refresh_token as string)
      this.storage.init(data.user.id)
      this.lastKnownUserId = data.user.id

      let canUseE2EE = false
      if (data.current_device?.trust_state === 'trusted') {
        canUseE2EE = await hasUnlockedLocalIdentity(this.storage, data.user.id)
      }

      void this.registerCurrentDeviceNotificationCapability()

      return {
        user: data.user,
        currentDevice: data.current_device ?? null,
        devices: data.current_device ? [data.current_device] : [],
        canUseE2EE,
        recoveryMnemonic: null
      }
    })
  }

  async checkAuth(): Promise<VesperAuthSession | null> {
    return await this.withStorageContext(this.resolveKnownUserId(), async () => {
      const token = this.httpClient.getAccessToken()
      if (!token) {
        return null
      }

      const response = await this.httpClient.apiFetch('/api/v1/auth/me')
      if (!response.ok) {
        this.httpClient.clearTokens()
        return null
      }

      const data = (await response.json()) as AuthResponsePayload
      this.storage.init(data.user.id)
      this.lastKnownUserId = data.user.id

      let canUseE2EE = false
      if (
        data.current_device?.trust_state === 'trusted' &&
        (await hasUnlockedLocalIdentity(this.storage, data.user.id))
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
    })
  }

  async logout(): Promise<void> {
    await this.withStorageContext(this.resolveKnownUserId(), async () => {
      try {
        await this.httpClient.apiFetch('/api/v1/auth/logout', { method: 'POST' })
      } catch {
        // Ignore logout transport failures.
      }

      this.socketClient.disconnect()
      this.httpClient.clearTokens()
      this.lastKnownUserId = null
      clearSearchIndexSyncCredentials()
    })
  }

  async verifyRecoveryKey(mnemonic: string): Promise<void> {
    await this.withStorageContext(null, async () => {
      const recoveryKeyHash = await hashRecoveryMnemonic(mnemonic)
      const response = await this.httpClient.apiFetch('/api/v1/auth/recover', {
        method: 'POST',
        body: JSON.stringify({ recovery_key_hash: recoveryKeyHash })
      })

      const data = (await response.json()) as Record<string, unknown>
      if (!response.ok || typeof data.encrypted_recovery_bundle !== 'string') {
        throw new Error(parseError(data, 'Invalid recovery key'))
      }

      const encryptedBundle = base64ToUint8(data.encrypted_recovery_bundle)
      await decryptWithRecoveryKey(mnemonic, encryptedBundle)
    })
  }

  async fetchDevices(params: {
    devices: VesperAuthDevice[]
    currentDevice: VesperAuthDevice | null
    user: VesperUser | null
  }): Promise<DeviceListState> {
    return await this.withStorageContext(params.user?.id ?? null, async () => {
      const response = await this.httpClient.apiFetch('/api/v1/auth/devices')
      if (!response.ok) {
        return {
          devices: params.devices,
          currentDevice: params.currentDevice,
          canUseE2EE:
            params.user && params.currentDevice?.trust_state === 'trusted'
              ? await hasUnlockedLocalIdentity(this.storage, params.user.id)
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
      this.lastKnownUserId = params.user?.id ?? this.lastKnownUserId
      const canUseE2EE =
        params.user && currentDevice?.trust_state === 'trusted'
          ? await hasUnlockedLocalIdentity(this.storage, params.user.id)
          : false

      return {
        devices,
        currentDevice,
        canUseE2EE
      }
    })
  }

  async approveDevice(deviceId: string): Promise<void> {
    await this.withStorageContext(this.resolveKnownUserId(), async () => {
      const response = await this.httpClient.apiFetch(`/api/v1/auth/devices/${deviceId}/approve`, {
        method: 'POST'
      })

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
        throw new Error(parseError(data, 'Could not approve this device'))
      }
    })
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.withStorageContext(this.resolveKnownUserId(), async () => {
      const response = await this.httpClient.apiFetch(`/api/v1/auth/devices/${deviceId}/revoke`, {
        method: 'POST'
      })

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
        throw new Error(parseError(data, 'Could not remove this device'))
      }
    })
  }

  async approveCurrentDeviceWithRecovery(mnemonic: string): Promise<VesperAuthSession> {
    return await this.withStorageContext(this.resolveKnownUserId(), async () => {
      const recoveryKeyHash = await hashRecoveryMnemonic(mnemonic)

      const recoverResponse = await this.httpClient.apiFetch('/api/v1/auth/recover', {
        method: 'POST',
        body: JSON.stringify({ recovery_key_hash: recoveryKeyHash })
      })
      const recoverData = (await recoverResponse.json()) as Record<string, unknown>

      if (!recoverResponse.ok || typeof recoverData.encrypted_recovery_bundle !== 'string') {
        throw new Error(parseError(recoverData, 'Recovery key was not accepted'))
      }

      const approveResponse = await this.httpClient.apiFetch('/api/v1/auth/devices/approve-with-recovery', {
        method: 'POST',
        body: JSON.stringify({ recovery_key_hash: recoveryKeyHash })
      })
      const approveData = (await approveResponse.json()) as Record<string, unknown> & AuthResponsePayload

      if (!approveResponse.ok) {
        throw new Error(parseError(approveData, 'Could not approve this device'))
      }

      if (approveData.access_token && approveData.refresh_token) {
        this.httpClient.setTokens(approveData.access_token, approveData.refresh_token)
      } else {
        const refreshToken = this.httpClient.getRefreshToken()
        if (refreshToken) {
          const refreshResponse = await this.httpClient.apiFetch('/api/v1/auth/refresh', {
            method: 'POST',
            body: JSON.stringify({ refresh_token: refreshToken })
          })
          const refreshData = (await refreshResponse.json()) as AuthResponsePayload

          if (refreshResponse.ok && refreshData.access_token && refreshData.refresh_token) {
            this.httpClient.setTokens(refreshData.access_token, refreshData.refresh_token)
          }
        }
      }

      const session = await this.requireCurrentSession(
        'This device was approved, but Vesper could not finish setup.'
      )
      this.lastKnownUserId = session.user.id

      const restored = await this.createFreshLocalDeviceIdentity(session.user.id)
      if (!restored) {
        throw new Error('This device was approved, but encrypted chat setup could not be completed.')
      }

      return {
        ...session,
        currentDevice: approveData.current_device ?? session.currentDevice,
        canUseE2EE: true
      }
    })
  }

  async unlockTrustedDevice(
    user: VesperUser,
    currentDevice: VesperAuthDevice | null,
    password: string
  ): Promise<VesperAuthSession> {
    return await this.withStorageContext(user.id, async () => {
      if (currentDevice?.trust_state !== 'trusted') {
        throw new Error('This device is not approved yet.')
      }

      const response = await this.httpClient.apiFetch('/api/v1/auth/me')
      const data = (await response.json()) as Record<string, unknown> & AuthResponsePayload

      if (!response.ok) {
        throw new Error(parseError(data, 'Could not load device setup'))
      }

      const restored =
        (await hasUnlockedLocalIdentity(this.storage, user.id)) ||
        (shouldGenerateFreshDeviceIdentity(data.current_device) &&
          (await this.createFreshLocalDeviceIdentity(user.id))) ||
        (await hydrateTrustedCryptoFromPasswordResponse(this.storage, user.id, data, password))

      if (!restored) {
        throw new Error(
          'This device is approved, but it still needs your password to unlock encrypted chats.'
        )
      }

      this.lastKnownUserId = user.id

      return {
        user,
        currentDevice: data.current_device ?? currentDevice,
        devices: data.current_device ? [data.current_device] : currentDevice ? [currentDevice] : [],
        canUseE2EE: true,
        recoveryMnemonic: null
      }
    })
  }

  async recoverAccount(mnemonic: string, newPassword: string): Promise<VesperAuthSession> {
    return await this.withStorageContext(null, async () => {
      const recoveryKeyHash = await hashRecoveryMnemonic(mnemonic)
      const response = await this.httpClient.apiFetch('/api/v1/auth/recover', {
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

      const resetResponse = await this.httpClient.apiFetch('/api/v1/auth/recover/reset', {
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

      this.httpClient.setTokens(resetData.access_token as string, resetData.refresh_token as string)
      this.storage.init(resetData.user.id)
      this.lastKnownUserId = resetData.user.id

      await this.storage.saveIdentity(
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
    })
  }

  async updateProfile(attrs: {
    display_name?: string | null
    avatar_url?: string
    banner_url?: string
    status?: string
  }): Promise<VesperUser> {
    const response = await this.httpClient.apiFetch('/api/v1/auth/profile', {
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

    const response = await this.httpClient.apiUpload('/api/v1/auth/avatar', formData)
    if (!response.ok) {
      throw new Error('Could not upload avatar')
    }

    const data = (await response.json()) as { user: VesperUser }
    return data.user
  }

  async uploadBanner(file: File): Promise<VesperUser> {
    const formData = new FormData()
    formData.append('file', file)

    const response = await this.httpClient.apiUpload('/api/v1/auth/banner', formData)
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

    this.keyPackageReplenishPromise = this.withStorageContext(user?.id ?? null, async () => {
      if (!user || !canUseE2EE) {
        return
      }

      const localPackages = await this.storage.loadKeyPackages()
      if (localPackages.length === 0) {
        await purgeMyKeyPackages(this.resolveDeviceIdentity().id, this.httpClient)
      }

      const count = await getMyKeyPackageCount(this.resolveDeviceIdentity().id, this.httpClient)
      if (count >= KEY_PACKAGE_THRESHOLD) {
        return
      }

      await initCipherSuite()
      const identity = await this.storage.loadIdentity(user.id)
      if (!identity?.signaturePrivateKey) {
        return
      }

      const identityData = buildIdentityData(
        this.getCurrentMlsCredentialIdentity(user.id),
        identity.publicIdentityKey
      )

      const pairs = await createKeyPackageBatch(
        identityData,
        identity.signaturePrivateKey,
        KEY_PACKAGE_TARGET - count,
      )

      await this.storage.saveKeyPackages(
        pairs.map((pair) => ({
          publicData: pair.publicData,
          privateData: pair.privateData
        }))
      )

      const publicPackageBytes = pairs.map((pair) => pair.publicData)
      await uploadKeyPackages(publicPackageBytes, this.resolveDeviceIdentity().id, this.httpClient)
    }).finally(() => {
      this.keyPackageReplenishPromise = null
    })

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

  private resolveKnownUserId(): string | null {
    return this.lastKnownUserId
  }

  private async withStorageContext<T>(
    userId: string | null | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    return await this.storage.run(userId, operation)
  }

  private async createFreshLocalDeviceIdentity(userId: string): Promise<boolean> {
    await initCipherSuite()

    const signingIdentity = await createSigningIdentity(
      this.getCurrentMlsCredentialIdentity(userId)
    )
    const signaturePrivateKey = signingIdentity.privateKeyBundle
    const signaturePublicKey = signingIdentity.signaturePublicKey

    await this.storage.saveIdentity(
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
      await this.httpClient.apiFetch('/api/v1/auth/devices/current/notifications', {
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

export function createVesperAuthClient(
  options: VesperAuthClientOptions = {}
): VesperAuthClient {
  return new VesperAuthClient(options)
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
  return (
    currentDevice?.approval_method === 'trusted_device' ||
    currentDevice?.approval_method === 'recovery_key'
  )
}

async function hasUnlockedLocalIdentity(
  storage: CryptoStorageRuntime,
  userId: string
): Promise<boolean> {
  const identity = await storage.loadIdentity(userId).catch(() => null)
  return Boolean(identity?.signaturePrivateKey)
}

async function hydrateTrustedCryptoFromPasswordResponse(
  storage: CryptoStorageRuntime,
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

  await storage.saveIdentity(
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
