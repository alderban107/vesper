import { useState } from 'react'
import { ArrowRight, KeyRound, Laptop2, Loader2, ShieldCheck, User } from 'lucide-react'
import AuthShell from '../components/auth/AuthShell'
import { useAuthStore } from '../stores/authStore'

interface Props {
  onSwitchToLogin: () => void
}

const registerFeatures = [
  {
    icon: ShieldCheck,
    label: 'Identity-first setup',
    description: 'Your account creates the encrypted keys that protect your history.'
  },
  {
    icon: Laptop2,
    label: 'Ready for more devices',
    description: 'Trusted device approvals keep future logins in sync instead of splintered.'
  },
  {
    icon: KeyRound,
    label: 'Recovery key on signup',
    description: 'You get one recovery path for restoring access without server-side plaintext.'
  }
]

export default function RegisterPage({ onSwitchToLogin }: Props): React.JSX.Element {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const { register, error } = useAuthStore()
  const [loading, setLoading] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setLocalError(null)

    if (password !== confirmPassword) {
      setLocalError('Passwords do not match')
      return
    }

    setLoading(true)
    await register(username, password)
    setLoading(false)
  }

  const displayError = localError || error

  return (
    <AuthShell
      formEyebrow="New account"
      formTitle="Create your account"
      formDescription="Set up your identity once, then carry your encrypted chat state across devices."
      panelEyebrow="Portable history"
      panelTitle="One account, one encrypted identity, many trusted devices."
      panelDescription="Registering creates the foundation for fast device approvals, recovery, and sync that behaves like a real chat app."
      features={registerFeatures}
    >
      <form onSubmit={handleSubmit} data-testid="register-form" className="vesper-auth-form">
        {displayError && <div className="vesper-auth-error">{displayError}</div>}

        <label className="vesper-auth-field">
          <span className="vesper-auth-label">Username</span>
          <div className="vesper-auth-input-wrap">
            <User className="vesper-auth-input-icon" />
            <input
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="vesper-auth-input input-focus"
              placeholder="Choose a username"
              autoFocus
            />
          </div>
        </label>

        <label className="vesper-auth-field">
          <span className="vesper-auth-label">Password</span>
          <div className="vesper-auth-input-wrap">
            <KeyRound className="vesper-auth-input-icon" />
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="vesper-auth-input input-focus"
              placeholder="Create a password"
            />
          </div>
        </label>

        <label className="vesper-auth-field">
          <span className="vesper-auth-label">Confirm password</span>
          <div className="vesper-auth-input-wrap">
            <KeyRound className="vesper-auth-input-icon" />
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              className="vesper-auth-input input-focus"
              placeholder="Repeat your password"
            />
          </div>
        </label>

        <button
          type="submit"
          disabled={loading || !username || !password || !confirmPassword}
          className="vesper-auth-submit glow-accent hover:glow-accent-hover disabled:opacity-40 disabled:shadow-none"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Creating account...
            </>
          ) : (
            <>
              Create account
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>

        <div className="vesper-auth-divider">
          <span>Already have an account?</span>
        </div>

        <button type="button" onClick={onSwitchToLogin} className="vesper-auth-secondary-button">
          Back to login
        </button>
      </form>
    </AuthShell>
  )
}
