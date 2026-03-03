import { create } from 'zustand'
import { apiFetch, apiUpload, setTokens, clearTokens, getAccessToken } from '../api/client'
import { connectSocket, disconnectSocket } from '../api/socket'
import { useServerStore } from './serverStore'
import { uint8ToBase64, base64ToUint8 } from '../api/crypto'
import {
  createEncryptedKeyBundle,
  decryptEncryptedKeyBundle,
  createRecoveryData
} from '../crypto/identity'
import { initCipherSuite, createKeyPackageBatch, encodeKeyPackageBytes } from '../crypto/mls'
import { saveIdentity, saveKeyPackages } from '../crypto/storage'
import { uploadKeyPackages, getMyKeyPackageCount } from '../api/crypto'

interface User {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  status: string
}

interface AuthState {
  user: User | null
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null
  recoveryMnemonic: string | null

  register: (username: string, password: string) => Promise<boolean>
  login: (username: string, password: string) => Promise<boolean>
  logout: () => Promise<void>
  checkAuth: () => Promise<void>
  clearRecoveryMnemonic: () => void
  replenishKeyPackages: () => Promise<void>
  updateProfile: (attrs: { display_name?: string | null; avatar_url?: string; status?: string }) => Promise<boolean>
  uploadAvatar: (file: File) => Promise<boolean>
}

const KEY_PACKAGE_TARGET = 20
const KEY_PACKAGE_THRESHOLD = 5

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  error: null,
  recoveryMnemonic: null,

  register: async (username, password) => {
    set({ error: null })

    try {
      // Initialize cipher suite
      await initCipherSuite()

      // Generate a key package to extract the signature key pair
      const keyPackages = await createKeyPackageBatch(username, 1)
      const signaturePrivateKey = keyPackages[0].privatePackage.signaturePrivateKey
      const signaturePublicKey = keyPackages[0].publicPackage.leafNode.signaturePublicKey

      // Encrypt the private keys with the user's password
      const privateKeysBundle = signaturePrivateKey
      const encryptedBundle = await createEncryptedKeyBundle(privateKeysBundle, password)

      // Generate recovery key and encrypt private keys with it
      const recoveryData = await createRecoveryData(privateKeysBundle)

      // Register with server, sending crypto fields
      const res = await apiFetch('/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({
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
      })

      const data = await res.json()

      if (!res.ok) {
        const errorMsg =
          data.errors
            ? Object.entries(data.errors)
                .map(([k, v]) => `${k}: ${(v as string[]).join(', ')}`)
                .join('; ')
            : data.error || 'Registration failed'
        set({ error: errorMsg })
        return false
      }

      setTokens(data.access_token, data.refresh_token)
      connectSocket()

      // Store identity keys locally
      await saveIdentity(
        data.user.id,
        signaturePublicKey,
        signaturePublicKey,
        encryptedBundle.ciphertext,
        encryptedBundle.nonce,
        encryptedBundle.salt
      )

      // Generate and upload key packages (use the same signature key pair)
      const batchPairs = await createKeyPackageBatch(username, KEY_PACKAGE_TARGET, {
        signKey: signaturePrivateKey,
        publicKey: signaturePublicKey
      })

      // Save private key packages locally
      await saveKeyPackages(
        batchPairs.map((p) => ({
          publicData: encodeKeyPackageBytes(p.publicPackage),
          privateData: new Uint8Array([
            ...p.privatePackage.initPrivateKey,
            ...p.privatePackage.hpkePrivateKey,
            ...p.privatePackage.signaturePrivateKey
          ])
        }))
      )

      // Upload public key packages to server
      const publicPackageBytes = batchPairs.map((p) => encodeKeyPackageBytes(p.publicPackage))
      await uploadKeyPackages(publicPackageBytes)

      set({
        user: data.user,
        isAuthenticated: true,
        error: null,
        recoveryMnemonic: recoveryData.mnemonic
      })
      return true
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not connect to server'
      set({ error: msg })
      return false
    }
  },

  login: async (username, password) => {
    set({ error: null })

    try {
      const res = await apiFetch('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      })

      const data = await res.json()

      if (!res.ok) {
        set({ error: data.error || 'Login failed' })
        return false
      }

      setTokens(data.access_token, data.refresh_token)
      connectSocket()

      // If user has encrypted key bundle, decrypt it and store locally
      if (data.encrypted_key_bundle) {
        try {
          await initCipherSuite()

          const bundle = {
            ciphertext: base64ToUint8(data.encrypted_key_bundle),
            nonce: base64ToUint8(data.key_bundle_nonce),
            salt: base64ToUint8(data.key_bundle_salt)
          }

          const privateKeys = await decryptEncryptedKeyBundle(bundle, password)

          // Store decrypted identity locally
          await saveIdentity(
            data.user.id,
            bundle.ciphertext, // We stored the public key on the server
            bundle.ciphertext,
            bundle.ciphertext,
            bundle.nonce,
            bundle.salt
          )

          // Check and replenish key packages
          const count = await getMyKeyPackageCount()
          if (count < KEY_PACKAGE_THRESHOLD) {
            const toGenerate = KEY_PACKAGE_TARGET - count
            // We need the signature key pair to generate new key packages
            // The private key is the decrypted bundle
            const signaturePrivateKey = privateKeys
            const pairs = await createKeyPackageBatch(username, toGenerate, {
              signKey: signaturePrivateKey,
              publicKey: signaturePrivateKey // Will be overridden by the key package generation
            })

            const publicPackageBytes = pairs.map((p) => encodeKeyPackageBytes(p.publicPackage))
            await uploadKeyPackages(publicPackageBytes)

            await saveKeyPackages(
              pairs.map((p) => ({
                publicData: encodeKeyPackageBytes(p.publicPackage),
                privateData: new Uint8Array([
                  ...p.privatePackage.initPrivateKey,
                  ...p.privatePackage.hpkePrivateKey,
                  ...p.privatePackage.signaturePrivateKey
                ])
              }))
            )
          }
        } catch {
          // Crypto setup failed — continue without E2EE for now
          console.warn('Failed to set up encryption keys')
        }
      }

      set({ user: data.user, isAuthenticated: true, error: null })
      return true
    } catch {
      set({ error: 'Could not connect to server' })
      return false
    }
  },

  logout: async () => {
    try {
      await apiFetch('/api/v1/auth/logout', { method: 'POST' })
    } catch {
      // ignore
    }
    disconnectSocket()
    clearTokens()
    set({ user: null, isAuthenticated: false, error: null, recoveryMnemonic: null })
  },

  checkAuth: async () => {
    const token = getAccessToken()
    if (!token) {
      set({ isLoading: false, isAuthenticated: false })
      return
    }

    try {
      const res = await apiFetch('/api/v1/auth/me')
      if (res.ok) {
        const data = await res.json()
        connectSocket()

        // Initialize cipher suite for later use
        initCipherSuite().catch(() => {
          console.warn('Failed to initialize cipher suite')
        })

        set({ user: data.user, isAuthenticated: true, isLoading: false })
      } else {
        clearTokens()
        set({ isLoading: false, isAuthenticated: false })
      }
    } catch {
      set({ isLoading: false })
    }
  },

  clearRecoveryMnemonic: () => {
    set({ recoveryMnemonic: null })
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
        // Refresh member list so other components see the updated name
        const serverId = useServerStore.getState().activeServerId
        if (serverId) useServerStore.getState().fetchMembers(serverId)
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
        if (serverId) useServerStore.getState().fetchMembers(serverId)
        return true
      }
    } catch {
      // ignore
    }
    return false
  },

  replenishKeyPackages: async () => {
    const user = get().user
    if (!user) return

    try {
      const count = await getMyKeyPackageCount()
      if (count >= KEY_PACKAGE_THRESHOLD) return

      await initCipherSuite()
      const toGenerate = KEY_PACKAGE_TARGET - count
      const pairs = await createKeyPackageBatch(user.username, toGenerate)

      const publicPackageBytes = pairs.map((p) => encodeKeyPackageBytes(p.publicPackage))
      await uploadKeyPackages(publicPackageBytes)

      await saveKeyPackages(
        pairs.map((p) => ({
          publicData: encodeKeyPackageBytes(p.publicPackage),
          privateData: new Uint8Array([
            ...p.privatePackage.initPrivateKey,
            ...p.privatePackage.hpkePrivateKey,
            ...p.privatePackage.signaturePrivateKey
          ])
        }))
      )
    } catch {
      console.warn('Failed to replenish key packages')
    }
  }
}))
