import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import AuthShell from '../components/auth/AuthShell'
import { useSettingsStore } from '../stores/settingsStore'
import { useAuthStore } from '../stores/authStore'

interface Props {
  onSwitchToRegister: () => void
  onSwitchToRecovery: () => void
}

export default function LoginPage({ onSwitchToRegister, onSwitchToRecovery }: Props): React.JSX.Element {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [serverEditorOpen, setServerEditorOpen] = useState(false)
  const [serverDraft, setServerDraft] = useState('')
  const [serverStatus, setServerStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const { login, error } = useAuthStore()
  const serverUrl = useSettingsStore((state) => state.serverUrl)
  const setServerUrl = useSettingsStore((state) => state.setServerUrl)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setServerDraft(serverUrl)
  }, [serverUrl])

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setLoading(true)
    await login(username, password)
    setLoading(false)
  }

  const handleSaveServer = (): void => {
    if (!serverDraft.trim()) {
      return
    }

    setServerUrl(serverDraft.trim())
    setServerStatus('idle')
  }

  const handleTestServer = async (): Promise<void> => {
    const trimmed = serverDraft.trim()
    if (!trimmed) {
      return
    }

    setServerStatus('testing')
    try {
      const response = await fetch(`${trimmed.replace(/\/+$/, '')}/api/v1/auth/me`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      })
      setServerStatus(response.ok || response.status === 401 ? 'success' : 'error')
    } catch {
      setServerStatus('error')
    }
  }

  return (
    <AuthShell
      centered
      formTitle="Welcome back"
      formDescription="We're excited to see you again."
      panelEyebrow=""
      panelTitle=""
      panelDescription=""
      features={[]}
    >
      <form onSubmit={handleSubmit} data-testid="login-form" className="vesper-auth-form">
        {error && <div className="vesper-auth-error">{error}</div>}

        <label className="vesper-auth-field">
          <span className="vesper-auth-label">Username</span>
          <input
            type="text"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            className="vesper-auth-input vesper-auth-input-plain input-focus"
            autoFocus
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
          />
        </label>

        <button
          type="submit"
          disabled={loading || !username || !password}
          className="vesper-auth-submit glow-accent hover:glow-accent-hover disabled:opacity-40 disabled:shadow-none"
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

        <div className="vesper-auth-server-block">
          <button
            type="button"
            className="vesper-auth-server-toggle"
            onClick={() => setServerEditorOpen((open) => !open)}
          >
            {serverEditorOpen ? 'Hide server options' : 'Use a different server'}
          </button>
          <div className="vesper-auth-server-current">{serverUrl}</div>

          {serverEditorOpen ? (
            <div className="vesper-auth-server-editor">
              <label className="vesper-auth-field">
                <span className="vesper-auth-label">Backend server URL</span>
                <input
                  type="text"
                  value={serverDraft}
                  onChange={(event) => {
                    setServerDraft(event.target.value)
                    setServerStatus('idle')
                  }}
                  className="vesper-auth-input vesper-auth-input-plain input-focus"
                  placeholder="http://localhost:4000"
                />
              </label>

              <div className="vesper-auth-server-actions">
                <button
                  type="button"
                  onClick={() => void handleTestServer()}
                  className="vesper-auth-tertiary-button"
                >
                  {serverStatus === 'testing' ? 'Testing...' : 'Test'}
                </button>
                <button
                  type="button"
                  onClick={handleSaveServer}
                  className="vesper-auth-tertiary-button"
                  disabled={!serverDraft.trim() || serverDraft.trim() === serverUrl}
                >
                  Save
                </button>
              </div>

              {serverStatus === 'success' ? (
                <div className="vesper-auth-server-feedback">Server responded.</div>
              ) : null}
              {serverStatus === 'error' ? (
                <div className="vesper-auth-server-feedback vesper-auth-server-feedback-error">
                  Could not reach that server.
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </form>
    </AuthShell>
  )
}
