import { useState } from 'react'
import { Folder, Hash, Volume2, Loader2 } from 'lucide-react'
import { useServerStore } from '../../stores/serverStore'
import { useUIStore } from '../../stores/uiStore'

const CHANNEL_TYPE_OPTIONS = [
  {
    id: 'text',
    label: 'Text Channel',
    description: 'Post messages, images, links, and updates for everyone in the server.',
    icon: Hash
  },
  {
    id: 'voice',
    label: 'Voice Channel',
    description: 'Hang out with voice and screen sharing when people want to jump in live.',
    icon: Volume2
  },
  {
    id: 'category',
    label: 'Category',
    description: 'Organize text and voice channels into a cleaner, easier-to-scan sidebar.',
    icon: Folder
  }
] as const

export default function CreateChannelModal(): React.JSX.Element {
  const [name, setName] = useState('')
  const [type, setType] = useState<'text' | 'voice' | 'category'>('text')
  const [categoryId, setCategoryId] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const activeServerId = useServerStore((s) => s.activeServerId)
  const activeServer = useServerStore((s) => s.servers.find((server) => server.id === s.activeServerId))
  const createChannel = useServerStore((s) => s.createChannel)
  const setActiveChannel = useServerStore((s) => s.setActiveChannel)
  const closeModal = useUIStore((s) => s.closeCreateChannelModal)
  const categories = (activeServer?.channels ?? []).filter((channel) => channel.type === 'category')

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!name.trim() || !activeServerId) return

    setLoading(true)
    const channel = await createChannel(
      activeServerId,
      name.trim(),
      type,
      type === 'category' ? null : categoryId || null
    )
    setLoading(false)

    if (channel) {
      if (type === 'text') {
        setActiveChannel(channel.id)
      }
      closeModal()
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          closeModal()
        }
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="glass-card rounded-2xl p-6 w-[30rem] max-w-[calc(100vw-2rem)] animate-scale-in"
      >
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center shrink-0">
            {type === 'category' ? (
              <Folder className="w-5 h-5 text-accent" />
            ) : type === 'voice' ? (
              <Volume2 className="w-5 h-5 text-accent" />
            ) : (
              <Hash className="w-5 h-5 text-accent" />
            )}
          </div>
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Create Channel</h2>
            <p className="text-sm text-text-faint">Choose how people will use this space.</p>
          </div>
        </div>

        <div className="mb-5">
          <span className="text-text-muted text-sm font-medium block mb-2">Channel Type</span>
          <div className="grid gap-3">
            {CHANNEL_TYPE_OPTIONS.map((option) => {
              const Icon = option.icon
              const selected = type === option.id

              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setType(option.id)}
                  className={selected ? 'vesper-channel-type-card vesper-channel-type-card-active' : 'vesper-channel-type-card'}
                >
                  <span className="vesper-channel-type-card-icon">
                    <Icon className="w-4 h-4" />
                  </span>
                  <span className="vesper-channel-type-card-copy">
                    <span className="vesper-channel-type-card-title">{option.label}</span>
                    <span className="vesper-channel-type-card-description">{option.description}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        <label className="block mb-5">
          <span className="text-text-muted text-sm font-medium">Channel Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={
              type === 'voice'
                ? 'general voice'
                : type === 'category'
                  ? 'Text Channels'
                  : 'general'
            }
            className="mt-1 block w-full rounded-lg bg-bg-base/50 border border-border text-text-primary px-3 py-2.5 input-focus"
            autoFocus
          />
          <span className="mt-2 block text-xs text-text-faint">
            {type === 'category'
              ? 'Categories let you group channels together and reorder larger sections of the sidebar.'
              : type === 'voice'
              ? 'Good for drop-ins, live conversation, and quick calls.'
              : 'Good for async updates, files, links, and searchable discussion.'}
          </span>
        </label>

        {type !== 'category' && categories.length > 0 && (
          <label className="block mb-5">
            <span className="text-text-muted text-sm font-medium">Category</span>
            <select
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
              className="mt-1 block w-full rounded-lg bg-bg-base/50 border border-border text-text-primary px-3 py-2.5 input-focus"
            >
              <option value="">No category</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
        )}

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
