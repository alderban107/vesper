import { useState } from 'react'
import { Loader2, Settings } from 'lucide-react'
import AuthShell from '../components/auth/AuthShell'
import ServerConnectionCard from '../components/auth/ServerConnectionCard'
import { useSettingsStore } from '../stores/settingsStore'
import { useAuthStore } from '../stores/authStore'

interface Props {
  onSwitchToRegister: () => void
  onSwitchToRecovery: () => void
}

export default function LoginPage({ onSwitchToRegister, onSwitchToRecovery }: Props): React.JSX.Element {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const { login, error } = useAuthStore()
  const serverUrl = useSettingsStore((state) => state.serverUrl)
  const [loading, setLoading] = useState(false)
  const [showServerModal, setShowServerModal] = useState(false)
  const hasServerUrl = serverUrl.trim().length > 0

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setLoading(true)
    await login(username, password)
    setLoading(false)
  }

  return (
    <AuthShell
      centered
      formTitle="Welcome back"
      formDescription="Sign in to pick up your account, devices, and encrypted history."
      panelEyebrow=""
      panelTitle=""
      panelDescription=""
      features={[]}
    >
      <button
        type="button"
        onClick={() => setShowServerModal(true)}
        className="vesper-auth-server-cog"
        title="Server settings"
      >
        <Settings className="w-4 h-4" />
      </button>

      {showServerModal && (
        <div className="vesper-auth-server-modal-backdrop" onClick={() => setShowServerModal(false)}>
          <div className="vesper-auth-server-modal" onClick={(e) => e.stopPropagation()}>
            <ServerConnectionCard />
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} data-testid="login-form" className="vesper-auth-form">
        {error && <div className="vesper-auth-error">{error}</div>}
        {!hasServerUrl && (
          <div className="vesper-auth-error" style={{ borderColor: 'var(--color-border)' }}>
            No server configured. <button type="button" onClick={() => setShowServerModal(true)} className="vesper-auth-inline-link">Set one up</button> to continue.
          </div>
        )}

        <label className="vesper-auth-field">
          <span className="vesper-auth-label">Username</span>
          <input
            type="text"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            className="vesper-auth-input vesper-auth-input-plain input-focus"
            autoFocus
            autoComplete="username"
            spellCheck={false}
          />
        </label>

        <label className="vesper-auth-field">
          <div className="vesper-auth-label-row">
            <span className="vesper-auth-label">Password</span>
            <button
              type="button"
              onClick={onSwitchToRecovery}
              className="vesper-auth-inline-link"
            >
              Forgot it?
            </button>
          </div>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="vesper-auth-input vesper-auth-input-plain input-focus"
            autoComplete="current-password"
          />
        </label>

        <button
          type="submit"
          disabled={loading || !username || !password || !hasServerUrl}
          className="vesper-auth-submit disabled:opacity-40"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Signing in...
            </>
          ) : (
            'Log In'
          )}
        </button>

        <div className="vesper-auth-register-row">
          <span>Need an account?</span>
          <button type="button" onClick={onSwitchToRegister} className="vesper-auth-inline-link">
            Register
          </button>
        </div>
      </form>
    </AuthShell>
  )
}
