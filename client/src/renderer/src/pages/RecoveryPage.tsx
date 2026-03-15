import { useState } from 'react'
import { Star, KeyRound, Lock, Loader2, ArrowLeft } from 'lucide-react'
import { apiFetch, setTokens } from '../api/client'
import { getLocalDeviceIdentity } from '../auth/deviceIdentity'
import { connectSocket } from '../api/socket'
import { uint8ToBase64, base64ToUint8 } from '../api/crypto'
import { decryptWithRecoveryKey, createEncryptedKeyBundle, recoveryKeyToBytes } from '../crypto/identity'
import { initStorage, saveIdentity } from '../crypto/storage'
import { useAuthStore } from '../stores/authStore'

interface Props {
  onBack: () => void
}

export default function RecoveryPage({ onBack }: Props): React.JSX.Element {
  const [mnemonic, setMnemonic] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<'mnemonic' | 'password'>('mnemonic')
  const [recoveryKeyHash, setRecoveryKeyHash] = useState<string | null>(null)
  const [privateKeys, setPrivateKeys] = useState<Uint8Array | null>(null)

  const handleVerifyMnemonic = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const keyBytes = await recoveryKeyToBytes(mnemonic)
      const hashBuffer = await crypto.subtle.digest('SHA-256', keyBytes)
      const hashArray = new Uint8Array(hashBuffer)
      const hash = Array.from(hashArray)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')

      const res = await apiFetch('/api/v1/auth/recover', {
        method: 'POST',
        body: JSON.stringify({ recovery_key_hash: hash })
      })

      const data = await res.json()
      if (!res.ok) {
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

  const handleSetNewPassword = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
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

      const res = await apiFetch('/api/v1/auth/recover/reset', {
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

      const data = await res.json()
      if (!res.ok) {
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
    <div className="h-screen bg-gradient-to-br from-bg-base via-bg-primary to-bg-base flex items-center justify-center">
      {step === 'mnemonic' ? (
        <form
          onSubmit={handleVerifyMnemonic}
          className="glass-card rounded-2xl p-8 w-[480px] animate-scale-in"
        >
          <div className="flex items-center justify-center gap-2 mb-4">
            <Star className="w-7 h-7 text-accent" />
            <h1 className="text-2xl font-bold text-gradient">Vesper</h1>
          </div>

          <h2 className="text-lg font-semibold text-text-primary text-center mb-1">Account Recovery</h2>
          <p className="text-text-muted text-sm mb-6 text-center">
            Enter your 24-word recovery key to restore access to your account.
          </p>

          {error && (
            <div className="bg-error-bg text-error text-sm rounded-lg p-3 mb-4 animate-fade-in">{error}</div>
          )}

          <label className="block mb-6">
            <span className="text-text-muted text-sm font-medium">Recovery Key</span>
            <div className="relative mt-1">
              <KeyRound className="absolute left-3 top-3 w-4 h-4 text-text-faint" />
              <textarea
                value={mnemonic}
                onChange={(e) => setMnemonic(e.target.value)}
                placeholder="Enter your 24 recovery words separated by spaces"
                rows={4}
                className="block w-full rounded-lg bg-bg-base/50 border border-border text-text-primary pl-10 pr-3 py-2.5 input-focus font-mono text-sm resize-none"
                autoFocus
              />
            </div>
          </label>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onBack}
              className="flex items-center gap-1.5 px-4 py-2.5 text-text-muted hover:text-text-primary text-sm transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
            <button
              type="submit"
              disabled={loading || !mnemonic.trim()}
              className="flex-1 glow-accent hover:glow-accent-hover disabled:opacity-40 disabled:shadow-none text-bg-base font-semibold py-2.5 rounded-lg transition-all flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Verifying...
                </>
              ) : (
                'Verify Recovery Key'
              )}
            </button>
          </div>
        </form>
      ) : (
        <form
          onSubmit={handleSetNewPassword}
          className="glass-card rounded-2xl p-8 w-96 animate-scale-in"
        >
          <div className="flex items-center justify-center gap-2 mb-4">
            <Star className="w-7 h-7 text-accent" />
            <h1 className="text-2xl font-bold text-gradient">Vesper</h1>
          </div>

          <h2 className="text-lg font-semibold text-text-primary text-center mb-1">Set New Password</h2>
          <p className="text-text-muted text-sm mb-6 text-center">
            Recovery key verified. Choose a new password to re-encrypt your keys.
          </p>

          {error && (
            <div className="bg-error-bg text-error text-sm rounded-lg p-3 mb-4 animate-fade-in">{error}</div>
          )}

          <label className="block mb-4">
            <span className="text-text-muted text-sm font-medium">New Password</span>
            <div className="relative mt-1">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-faint" />
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="block w-full rounded-lg bg-bg-base/50 border border-border text-text-primary pl-10 pr-3 py-2.5 input-focus"
                autoFocus
              />
            </div>
          </label>

          <label className="block mb-6">
            <span className="text-text-muted text-sm font-medium">Confirm Password</span>
            <div className="relative mt-1">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-faint" />
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="block w-full rounded-lg bg-bg-base/50 border border-border text-text-primary pl-10 pr-3 py-2.5 input-focus"
              />
            </div>
          </label>

          <button
            type="submit"
            disabled={loading || !newPassword || !confirmPassword}
            className="w-full glow-accent hover:glow-accent-hover disabled:opacity-40 disabled:shadow-none text-bg-base font-semibold py-2.5 rounded-lg transition-all flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving...
              </>
            ) : (
              'Set Password'
            )}
          </button>
        </form>
      )}
    </div>
  )
}
