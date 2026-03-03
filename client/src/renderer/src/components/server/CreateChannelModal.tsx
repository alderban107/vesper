import { useState } from 'react'
import { Hash, Volume2, Loader2 } from 'lucide-react'
import { useServerStore } from '../../stores/serverStore'
import { useUIStore } from '../../stores/uiStore'

export default function CreateChannelModal(): React.JSX.Element {
  const [name, setName] = useState('')
  const [type, setType] = useState<'text' | 'voice'>('text')
  const [loading, setLoading] = useState(false)
  const activeServerId = useServerStore((s) => s.activeServerId)
  const createChannel = useServerStore((s) => s.createChannel)
  const setActiveChannel = useServerStore((s) => s.setActiveChannel)
  const closeModal = useUIStore((s) => s.closeCreateChannelModal)

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!name.trim() || !activeServerId) return

    setLoading(true)
    const channel = await createChannel(activeServerId, name.trim(), type)
    setLoading(false)

    if (channel) {
      if (type === 'text') {
        setActiveChannel(channel.id)
      }
      closeModal()
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <form
        onSubmit={handleSubmit}
        className="glass-card rounded-2xl p-6 w-96 max-w-[calc(100vw-2rem)] animate-scale-in"
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center">
            <Hash className="w-5 h-5 text-accent" />
          </div>
          <h2 className="text-lg font-semibold text-text-primary">Create Channel</h2>
        </div>

        <label className="block mb-4">
          <span className="text-text-muted text-sm font-medium">Channel Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 block w-full rounded-lg bg-bg-base/50 border border-border text-text-primary px-3 py-2.5 input-focus"
            autoFocus
          />
        </label>

        <div className="mb-4">
          <span className="text-text-muted text-sm font-medium block mb-2">Type</span>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setType('text')}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2 ${
                type === 'text'
                  ? 'bg-accent text-bg-base'
                  : 'bg-bg-base/50 text-text-muted hover:text-text-primary border border-border'
              }`}
            >
              <Hash className="w-4 h-4" />
              Text
            </button>
            <button
              type="button"
              onClick={() => setType('voice')}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2 ${
                type === 'voice'
                  ? 'bg-accent text-bg-base'
                  : 'bg-bg-base/50 text-text-muted hover:text-text-primary border border-border'
              }`}
            >
              <Volume2 className="w-4 h-4" />
              Voice
            </button>
          </div>
        </div>

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
            disabled={loading || !name.trim()}
            className="px-4 py-2 glow-accent hover:glow-accent-hover disabled:opacity-40 disabled:shadow-none text-bg-base rounded-lg text-sm font-medium transition-all flex items-center gap-2"
          >
            {loading ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Creating...
              </>
            ) : (
              'Create'
            )}
          </button>
        </div>
      </form>
    </div>
  )
}
