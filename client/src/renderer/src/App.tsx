import { Component, useEffect, useState, type ReactNode, type ErrorInfo } from 'react'
import { AlertTriangle, Star } from 'lucide-react'
import { useAuthStore } from './stores/authStore'
import {
  SESSION_NOTICE_EVENT,
  clearSessionNotice,
  getSessionNotice,
  type SessionNotice
} from './api/client'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import RecoveryPage from './pages/RecoveryPage'
import MainPage from './pages/MainPage'
import RecoveryKeyModal from './components/auth/RecoveryKeyModal'
import DeviceTrustGate from './components/auth/DeviceTrustGate'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('React crash:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="h-screen bg-bg-primary flex items-center justify-center p-8">
          <div className="glass-card rounded-2xl p-6 max-w-lg w-full">
            <h1 className="text-red-400 font-bold text-lg mb-2">Something went wrong</h1>
            <pre className="text-text-secondary text-sm whitespace-pre-wrap break-words mb-4">
              {this.state.error.message}
            </pre>
            <pre className="text-text-faint text-xs whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
              {this.state.error.stack}
            </pre>
            <button
              onClick={() => this.setState({ error: null })}
              className="mt-4 px-4 py-2 glow-accent text-bg-base rounded-lg text-sm font-medium"
            >
              Try Again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

function SessionNoticeModal({
  notice,
  onClose
}: {
  notice: SessionNotice
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-[200] bg-bg-base/86 backdrop-blur-md flex items-center justify-center p-6">
      <div className="glass-card rounded-3xl max-w-md w-full p-6 border border-border/60 shadow-2xl animate-scale-in">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-2xl bg-error/15 text-error flex items-center justify-center shrink-0">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-text-primary">{notice.title}</h2>
            <p className="text-text-muted mt-2">{notice.message}</p>
          </div>
        </div>

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="glow-accent hover:glow-accent-hover text-bg-base font-semibold px-5 py-2.5 rounded-xl transition-all"
          >
            Continue to sign in
          </button>
        </div>
      </div>
    </div>
  )
}

function App(): React.JSX.Element {
  const { isAuthenticated, isLoading, checkAuth, recoveryMnemonic, clearRecoveryMnemonic } =
    useAuthStore()
  const [page, setPage] = useState<'login' | 'register' | 'recovery'>('login')
  const [sessionNotice, setSessionNotice] = useState<SessionNotice | null>(() => getSessionNotice())

  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  useEffect(() => {
    const syncSessionNotice = (): void => {
      setSessionNotice(getSessionNotice())
    }

    window.addEventListener(SESSION_NOTICE_EVENT, syncSessionNotice)
    window.addEventListener('storage', syncSessionNotice)

    return () => {
      window.removeEventListener(SESSION_NOTICE_EVENT, syncSessionNotice)
      window.removeEventListener('storage', syncSessionNotice)
    }
  }, [])

  const handleDismissSessionNotice = (): void => {
    clearSessionNotice()
    setSessionNotice(null)
    setPage('login')
  }

  if (isLoading) {
    return (
      <div className="h-screen bg-bg-primary flex items-center justify-center">
        <div className="flex items-center gap-2 animate-fade-in">
          <Star className="w-6 h-6 text-accent animate-pulse" />
          <p className="text-text-faint">Loading...</p>
        </div>
      </div>
    )
  }

  if (!isAuthenticated) {
    if (page === 'register') {
      return (
        <>
          <RegisterPage onSwitchToLogin={() => setPage('login')} />
          {sessionNotice && (
            <SessionNoticeModal notice={sessionNotice} onClose={handleDismissSessionNotice} />
          )}
        </>
      )
    }
    if (page === 'recovery') {
      return (
        <>
          <RecoveryPage onBack={() => setPage('login')} />
          {sessionNotice && (
            <SessionNoticeModal notice={sessionNotice} onClose={handleDismissSessionNotice} />
          )}
        </>
      )
    }
    return (
      <>
        <LoginPage
          onSwitchToRegister={() => setPage('register')}
          onSwitchToRecovery={() => setPage('recovery')}
        />
        {sessionNotice && (
          <SessionNoticeModal notice={sessionNotice} onClose={handleDismissSessionNotice} />
        )}
      </>
    )
  }

  return (
    <>
      <MainPage />
      <DeviceTrustGate />
      {recoveryMnemonic && (
        <RecoveryKeyModal
          mnemonic={recoveryMnemonic}
          onConfirm={clearRecoveryMnemonic}
        />
      )}
    </>
  )
}

function AppWithErrorBoundary(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  )
}

export default AppWithErrorBoundary
