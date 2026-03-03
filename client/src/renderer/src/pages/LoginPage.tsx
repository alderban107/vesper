import { useState } from 'react'
import { Star, User, Lock, Loader2 } from 'lucide-react'
import { useAuthStore } from '../stores/authStore'

interface Props {
  onSwitchToRegister: () => void
  onSwitchToRecovery: () => void
}

export default function LoginPage({ onSwitchToRegister, onSwitchToRecovery }: Props): React.JSX.Element {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const { login, error } = useAuthStore()
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setLoading(true)
    await login(username, password)
    setLoading(false)
  }

  return (
    <div className="h-screen bg-gradient-to-br from-bg-base via-bg-primary to-bg-base flex items-center justify-center">
      <form
        onSubmit={handleSubmit}
        data-testid="login-form"
        className="glass-card rounded-2xl p-8 w-96 animate-scale-in"
      >
        <div className="flex items-center justify-center gap-2 mb-6">
          <Star className="w-7 h-7 text-accent" />
          <h1 className="text-2xl font-bold text-gradient">Vesper</h1>
        </div>

        <p className="text-text-muted text-sm text-center mb-6">Welcome back</p>

        {error && (
          <div className="bg-error-bg text-error text-sm rounded-lg p-3 mb-4 animate-fade-in">{error}</div>
        )}

        <label className="block mb-4">
          <span className="text-text-muted text-sm font-medium">Username</span>
          <div className="relative mt-1">
            <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-faint" />
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="block w-full rounded-lg bg-bg-base/50 border border-border text-text-primary pl-10 pr-3 py-2.5 input-focus"
              autoFocus
            />
          </div>
        </label>

        <label className="block mb-6">
          <span className="text-text-muted text-sm font-medium">Password</span>
          <div className="relative mt-1">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-faint" />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="block w-full rounded-lg bg-bg-base/50 border border-border text-text-primary pl-10 pr-3 py-2.5 input-focus"
            />
          </div>
        </label>

        <button
          type="submit"
          disabled={loading || !username || !password}
          className="w-full glow-accent hover:glow-accent-hover disabled:opacity-40 disabled:shadow-none text-bg-base font-semibold py-2.5 rounded-lg transition-all flex items-center justify-center gap-2"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Logging in...
            </>
          ) : (
            'Log In'
          )}
        </button>

        <p className="text-text-faint text-sm text-center mt-5">
          Don't have an account?{' '}
          <button
            type="button"
            onClick={onSwitchToRegister}
            className="text-accent-text hover:text-accent-text-hover transition-colors"
          >
            Register
          </button>
        </p>

        <p className="text-text-faint text-sm text-center mt-2">
          <button
            type="button"
            onClick={onSwitchToRecovery}
            className="text-accent-text hover:text-accent-text-hover transition-colors"
          >
            Forgot password?
          </button>
        </p>
      </form>
    </div>
  )
}
