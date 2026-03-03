import { useState } from 'react'
import { ArrowRightToLine, Loader2 } from 'lucide-react'
import { useServerStore } from '../../stores/serverStore'
import { useUIStore } from '../../stores/uiStore'

export default function JoinServerModal(): React.JSX.Element {
  const [inviteCode, setInviteCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const joinServer = useServerStore((s) => s.joinServer)
  const setActiveServer = useServerStore((s) => s.setActiveServer)
  const closeModal = useUIStore((s) => s.closeJoinServerModal)

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!inviteCode.trim()) return

    setError(null)
    setLoading(true)
    const server = await joinServer(inviteCode.trim())
    setLoading(false)

    if (server) {
      setActiveServer(server.id)
      closeModal()
    } else {
      setError('Invalid invite code')
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <form
        onSubmit={handleSubmit}
        className="glass-card rounded-2xl p-6 w-96 max-w-[calc(100vw-2rem)] animate-scale-in"
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-violet/10 flex items-center justify-center">
            <ArrowRightToLine className="w-5 h-5 text-violet" />
          </div>
          <h2 className="text-lg font-semibold text-text-primary">Join a Server</h2>
        </div>

        {error && (
          <div className="bg-error-bg text-error text-sm rounded-lg p-3 mb-4 animate-fade-in">{error}</div>
        )}

        <label className="block mb-4">
          <span className="text-text-muted text-sm font-medium">Invite Code</span>
          <input
            type="text"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            placeholder="e.g. xK9m2Lpq"
            className="mt-1 block w-full rounded-lg bg-bg-base/50 border border-border text-text-primary px-3 py-2.5 input-focus font-mono"
            autoFocus
          />
        </label>

        <div className="flex gap-3 justify-end">
          <button
            type="button"
            onClick={closeModal}
            className="px-4 py-2 text-text-muted hover:text-text-primary text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading || !inviteCode.trim()}
            className="px-4 py-2 glow-accent hover:glow-accent-hover disabled:opacity-40 disabled:shadow-none text-bg-base rounded-lg text-sm font-medium transition-all flex items-center gap-2"
          >
            {loading ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Joining...
              </>
            ) : (
              'Join'
            )}
          </button>
        </div>
      </form>
    </div>
  )
}
