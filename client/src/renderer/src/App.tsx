import { Component, useEffect, useState, type ReactNode, type ErrorInfo } from 'react'
import { Star } from 'lucide-react'
import { useAuthStore } from './stores/authStore'
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

function App(): React.JSX.Element {
  const { isAuthenticated, isLoading, checkAuth, recoveryMnemonic, clearRecoveryMnemonic } =
    useAuthStore()
  const [page, setPage] = useState<'login' | 'register' | 'recovery'>('login')

  useEffect(() => {
    checkAuth()
  }, [checkAuth])

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
      return <RegisterPage onSwitchToLogin={() => setPage('login')} />
    }
    if (page === 'recovery') {
      return <RecoveryPage onBack={() => setPage('login')} />
    }
    return (
      <LoginPage
        onSwitchToRegister={() => setPage('register')}
        onSwitchToRecovery={() => setPage('recovery')}
      />
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
