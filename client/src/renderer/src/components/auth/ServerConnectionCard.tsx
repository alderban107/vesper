import { CheckCircle2, Loader2, Server, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'

type ServerStatus = 'idle' | 'testing' | 'success' | 'error'

export default function ServerConnectionCard(): React.JSX.Element {
  const serverUrl = useSettingsStore((state) => state.serverUrl)
  const setServerUrl = useSettingsStore((state) => state.setServerUrl)
  const [serverEditorOpen, setServerEditorOpen] = useState(false)
  const [serverDraft, setServerDraft] = useState('')
  const [serverStatus, setServerStatus] = useState<ServerStatus>('idle')
  const hasServerUrl = serverUrl.trim().length > 0

  useEffect(() => {
    setServerDraft(serverUrl)
  }, [serverUrl])

  useEffect(() => {
    if (!hasServerUrl) {
      setServerEditorOpen(true)
    }
  }, [hasServerUrl])

  const handleSaveServer = (): void => {
    const trimmed = serverDraft.trim()

    if (!trimmed) {
      return
    }

    setServerUrl(trimmed)
    setServerStatus('idle')
    setServerEditorOpen(false)
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
    <section
      className={`vesper-auth-callout ${
        hasServerUrl
          ? 'border-white/10 bg-white/4'
          : 'border-amber-400/20 bg-amber-500/8 text-text-secondary'
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${
            hasServerUrl
              ? 'bg-emerald-500/12 text-emerald-300'
              : 'bg-amber-500/12 text-amber-200'
          }`}
        >
          {hasServerUrl ? <CheckCircle2 className="h-4 w-4" /> : <Server className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-text-primary">
                {hasServerUrl ? 'Server ready' : 'Pick the server for this client'}
              </div>
              <p className="mt-1 text-sm text-text-muted">
                {hasServerUrl
                  ? 'This client keeps its own session and device state. Change the server here if you want to point it somewhere else.'
                  : 'Vesper does not hard-code a backend. Set the server URL once, then sign in or create an account.'}
              </p>
            </div>
            <button
              type="button"
              className="vesper-auth-inline-link shrink-0"
              onClick={() => setServerEditorOpen((open) => !open)}
            >
              {serverEditorOpen ? 'Hide' : hasServerUrl ? 'Edit' : 'Set server'}
            </button>
          </div>

          <div className="mt-3 break-all rounded-xl border border-white/6 bg-black/10 px-3 py-2 text-xs text-text-faint">
            {serverUrl || 'No server configured yet'}
          </div>

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
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
              </label>

              <div className="vesper-auth-server-actions">
                <button
                  type="button"
                  onClick={() => void handleTestServer()}
                  className="vesper-auth-tertiary-button"
                  disabled={!serverDraft.trim() || serverStatus === 'testing'}
                >
                  {serverStatus === 'testing' ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Testing...
                    </>
                  ) : (
                    'Test connection'
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleSaveServer}
                  className="vesper-auth-tertiary-button"
                  disabled={!serverDraft.trim() || serverDraft.trim() === serverUrl}
                >
                  Save server
                </button>
              </div>

              {serverStatus === 'success' ? (
                <div className="vesper-auth-server-feedback">Server responded and is ready.</div>
              ) : null}
              {serverStatus === 'error' ? (
                <div className="flex items-center gap-2 text-sm text-error">
                  <TriangleAlert className="h-4 w-4 shrink-0" />
                  Could not reach that server.
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
