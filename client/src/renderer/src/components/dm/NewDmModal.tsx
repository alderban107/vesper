import { useState } from 'react'
import { MessageCircle, Loader2, User } from 'lucide-react'
import { useDmStore } from '../../stores/dmStore'
import { useUIStore } from '../../stores/uiStore'

export default function NewDmModal(): React.JSX.Element {
  const [username, setUsername] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const closeNewDmModal = useUIStore((s) => s.closeNewDmModal)
  const searchUsers = useDmStore((s) => s.searchUsers)
  const createConversation = useDmStore((s) => s.createConversation)

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!username.trim()) return

    setError('')
    setIsLoading(true)

    try {
      const users = await searchUsers(username.trim())
      if (users.length === 0) {
        setError('User not found')
        setIsLoading(false)
        return
      }

      const targetUser = users[0]
      const conv = await createConversation([targetUser.id])
      if (conv) {
        closeNewDmModal()
      } else {
        setError('Could not create conversation')
      }
    } catch {
      setError('Something went wrong')
    }
    setIsLoading(false)
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="glass-card rounded-2xl p-6 w-96 max-w-[calc(100vw-2rem)] animate-scale-in">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center">
            <MessageCircle className="w-5 h-5 text-accent" />
          </div>
          <h2 className="text-lg font-semibold text-text-primary">New Message</h2>
        </div>

        <form onSubmit={handleSubmit}>
          <label className="block text-text-muted text-sm mb-1">Username</label>
          <div className="relative">
            <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-faint" />
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Enter exact username"
              autoFocus
              className="w-full bg-bg-base/50 text-text-primary pl-10 pr-3 py-2.5 rounded-lg border border-border input-focus text-sm"
            />
          </div>

          {error && <p className="text-error text-sm mt-2 animate-fade-in">{error}</p>}

          <div className="flex justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={closeNewDmModal}
              className="px-4 py-2 text-text-muted hover:text-text-primary text-sm transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!username.trim() || isLoading}
              className="px-4 py-2 glow-accent hover:glow-accent-hover disabled:opacity-40 disabled:shadow-none text-bg-base rounded-lg text-sm font-medium transition-all flex items-center gap-2"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Finding...
                </>
              ) : (
                'Start Chat'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
