import { Loader2, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'

type ServerStatus = 'idle' | 'testing' | 'success' | 'error'

export default function ServerConnectionCard({ onSave }: { onSave?: () => void }): React.JSX.Element {
  const serverUrl = useSettingsStore((state) => state.serverUrl)
  const setServerUrl = useSettingsStore((state) => state.setServerUrl)
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<ServerStatus>('idle')

  useEffect(() => {
    setDraft(serverUrl)
  }, [serverUrl])

  const handleSave = (): void => {
    const trimmed = draft.trim()
    if (!trimmed) return
    setServerUrl(trimmed)
    setStatus('idle')
    onSave?.()
  }

  const handleTest = async (): Promise<void> => {
    const trimmed = draft.trim()
    if (!trimmed) return
    setStatus('testing')
    try {
      const response = await fetch(`${trimmed.replace(/\/+$/, '')}/api/v1/auth/me`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      })
      setStatus(response.ok || response.status === 401 ? 'success' : 'error')
    } catch {
      setStatus('error')
    }
  }

  const isDirty = draft.trim() !== serverUrl

  return (
    <div className="vesper-server-card">
      <div className="vesper-server-card-title">Custom Backend Server</div>
      <p className="vesper-server-card-copy">Set the server URL this client authenticates with.</p>

      <label className="vesper-server-card-field">
        <span className="vesper-server-card-label">Server URL</span>
        <input
          type="text"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setStatus('idle') }}
          placeholder="https://vesper.example.com"
          className="vesper-server-card-input"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </label>

      <div className="vesper-server-card-actions">
        <button
          type="button"
          onClick={() => void handleTest()}
          disabled={!draft.trim() || status === 'testing'}
          className="vesper-server-card-btn vesper-server-card-btn-secondary"
        >
          {status === 'testing' ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Testing...</> : 'Test'}
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!draft.trim() || !isDirty}
          className="vesper-server-card-btn vesper-server-card-btn-primary"
        >
          Save
        </button>
      </div>

      {status === 'success' && (
        <div className="vesper-server-card-feedback vesper-server-card-feedback-ok">Server reachable.</div>
      )}
      {status === 'error' && (
        <div className="vesper-server-card-feedback vesper-server-card-feedback-err">
          <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
          Could not reach that server.
        </div>
      )}
    </div>
  )
}
