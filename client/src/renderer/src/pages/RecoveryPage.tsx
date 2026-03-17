import { useState } from 'react'
import { ArrowLeft, ArrowRight, KeyRound, Loader2, Lock, ShieldCheck, Smartphone } from 'lucide-react'
import { apiFetch, setTokens } from '../api/client'
import { getLocalDeviceIdentity } from '../auth/deviceIdentity'
import { connectSocket } from '../api/socket'
import { uint8ToBase64, base64ToUint8 } from '../api/crypto'
import { decryptWithRecoveryKey, createEncryptedKeyBundle, recoveryKeyToBytes } from '../crypto/identity'
import { initStorage, saveIdentity } from '../crypto/storage'
import AuthShell from '../components/auth/AuthShell'
import { useAuthStore } from '../stores/authStore'

interface Props {
  onBack: () => void
}

const recoveryFeatures = [
  {
    icon: KeyRound,
    label: 'Recovery key restore',
    description: 'Bring your encrypted identity onto a replacement device.'
  },
  {
    icon: Smartphone,
    label: 'Device continuity',
    description: 'Recovered access keeps your future logins attached to the same account state.'
  },
  {
    icon: ShieldCheck,
    label: 'No plaintext fallback',
    description: 'Recovery works from your key material, not a server-side copy of your messages.'
  }
]

export default function RecoveryPage({ onBack }: Props): React.JSX.Element {
  const [mnemonic, setMnemonic] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<'mnemonic' | 'password'>('mnemonic')
  const [recoveryKeyHash, setRecoveryKeyHash] = useState<string | null>(null)
  const [privateKeys, setPrivateKeys] = useState<Uint8Array | null>(null)

  const handleVerifyMnemonic = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const keyBytes = await recoveryKeyToBytes(mnemonic)
      const hashBuffer = await crypto.subtle.digest('SHA-256', keyBytes)
      const hashArray = new Uint8Array(hashBuffer)
      const hash = Array.from(hashArray)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')

      const response = await apiFetch('/api/v1/auth/recover', {
        method: 'POST',
        body: JSON.stringify({ recovery_key_hash: hash })
      })

      const data = await response.json()
      if (!response.ok) {
        setError(data.error || 'Invalid recovery key')
        setLoading(false)
        return
      }

      const encryptedBundle = base64ToUint8(data.encrypted_recovery_bundle)
      const decrypted = await decryptWithRecoveryKey(mnemonic, encryptedBundle)

      setRecoveryKeyHash(hash)
      setPrivateKeys(decrypted)
      setStep('password')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Recovery failed')
    }

    setLoading(false)
  }

  const handleSetNewPassword = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setError(null)

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    if (!recoveryKeyHash || !privateKeys) return

    setLoading(true)

    try {
      const newBundle = await createEncryptedKeyBundle(privateKeys, newPassword)
      const device = getLocalDeviceIdentity()

      const response = await apiFetch('/api/v1/auth/recover/reset', {
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

      const data = await response.json()
      if (!response.ok) {
        setError(data.error || 'Failed to reset password')
        setLoading(false)
        return
      }

      setTokens(data.access_token, data.refresh_token)
      connectSocket()
      initStorage(data.user.id)

      await saveIdentity(
        data.user.id,
        data.public_identity_key ? base64ToUint8(data.public_identity_key) : new Uint8Array(0),
        data.public_key_exchange ? base64ToUint8(data.public_key_exchange) : new Uint8Array(0),
        newBundle.ciphertext,
        newBundle.nonce,
        newBundle.salt,
        privateKeys
      )

      useAuthStore.setState({
        user: data.user,
        currentDevice: data.current_device ?? null,
        devices: data.current_device ? [data.current_device] : [],
        isAuthenticated: true,
        error: null,
        canUseE2EE: true
      })
      await useAuthStore.getState().fetchDevices()
      await useAuthStore.getState().replenishKeyPackages()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set new password')
    }

    setLoading(false)
  }

  return (
    <AuthShell
      formEyebrow={step === 'mnemonic' ? 'Account recovery' : 'Reset password'}
      formTitle={step === 'mnemonic' ? 'Recover your account' : 'Set a new password'}
      formDescription={
        step === 'mnemonic'
          ? 'Enter your recovery key to restore access to the encrypted identity tied to this account.'
          : 'Your key checked out. Set a fresh password to re-encrypt local account data on this device.'
      }
      panelEyebrow="Recovery path"
      panelTitle="Losing a device should be stressful, not fatal."
      panelDescription="Recovery keeps history portable without giving the server plaintext access to your messages or keys."
      features={recoveryFeatures}
    >
      {step === 'mnemonic' ? (
        <form onSubmit={handleVerifyMnemonic} className="vesper-auth-form">
          {error && <div className="vesper-auth-error">{error}</div>}

          <label className="vesper-auth-field">
            <span className="vesper-auth-label">Recovery key</span>
            <div className="vesper-auth-textarea-wrap">
              <KeyRound className="vesper-auth-input-icon vesper-auth-textarea-icon" />
              <textarea
                value={mnemonic}
                onChange={(event) => setMnemonic(event.target.value)}
                placeholder="Enter your 24 recovery words separated by spaces"
                rows={5}
                className="vesper-auth-textarea input-focus"
                autoFocus
              />
            </div>
          </label>

          <div className="vesper-auth-callout">
            Recovery works against your encrypted recovery bundle, then rebinds this device into the same account.
          </div>

          <div className="vesper-auth-actions">
            <button type="button" onClick={onBack} className="vesper-auth-tertiary-button">
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
            <button
              type="submit"
              disabled={loading || !mnemonic.trim()}
              className="vesper-auth-submit glow-accent hover:glow-accent-hover disabled:opacity-40 disabled:shadow-none"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Verifying...
                </>
              ) : (
                <>
                  Verify recovery key
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={handleSetNewPassword} className="vesper-auth-form">
          {error && <div className="vesper-auth-error">{error}</div>}

          <label className="vesper-auth-field">
            <span className="vesper-auth-label">New password</span>
            <div className="vesper-auth-input-wrap">
              <Lock className="vesper-auth-input-icon" />
              <input
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                className="vesper-auth-input input-focus"
                placeholder="Create a new password"
                autoFocus
              />
            </div>
          </label>

          <label className="vesper-auth-field">
            <span className="vesper-auth-label">Confirm password</span>
            <div className="vesper-auth-input-wrap">
              <Lock className="vesper-auth-input-icon" />
              <input
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                className="vesper-auth-input input-focus"
                placeholder="Repeat your new password"
              />
            </div>
          </label>

          <div className="vesper-auth-callout">
            This password encrypts local key material for this device. Your recovery key still matters if you lose it again.
          </div>

          <button
            type="submit"
            disabled={loading || !newPassword || !confirmPassword}
            className="vesper-auth-submit glow-accent hover:glow-accent-hover disabled:opacity-40 disabled:shadow-none"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Updating password...
              </>
            ) : (
              <>
                Finish recovery
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>
      )}
    </AuthShell>
  )
}
