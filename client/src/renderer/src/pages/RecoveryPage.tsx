import { useState } from 'react'
import { ArrowLeft, ArrowRight, KeyRound, Loader2, Lock, ShieldCheck, Smartphone } from 'lucide-react'
import AuthShell from '../components/auth/AuthShell'
import ServerConnectionCard from '../components/auth/ServerConnectionCard'
import { useAuthStore } from '../stores/authStore'
import { useSettingsStore } from '../stores/settingsStore'

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
  const serverUrl = useSettingsStore((state) => state.serverUrl)
  const verifyRecoveryKey = useAuthStore((state) => state.verifyRecoveryKey)
  const recoverAccount = useAuthStore((state) => state.recoverAccount)

  const handleVerifyMnemonic = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const verified = await verifyRecoveryKey(mnemonic)
      if (verified) {
        setStep('password')
      } else {
        setError(useAuthStore.getState().error || 'Invalid recovery key')
      }
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

    setLoading(true)

    try {
      const recovered = await recoverAccount(mnemonic, newPassword)
      if (!recovered) {
        setError(useAuthStore.getState().error || 'Failed to set new password')
      }
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
          <ServerConnectionCard />

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
                spellCheck={false}
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
              disabled={loading || !mnemonic.trim() || !serverUrl.trim()}
              className="vesper-auth-submit disabled:opacity-40"
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
                autoComplete="new-password"
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
                autoComplete="new-password"
              />
            </div>
          </label>

          <div className="vesper-auth-callout">
            This password encrypts local key material for this device. Your recovery key still matters if you lose it again.
          </div>

          <button
            type="submit"
            disabled={loading || !newPassword || !confirmPassword || !serverUrl.trim()}
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
