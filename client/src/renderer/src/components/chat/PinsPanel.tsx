import { useState, useEffect } from 'react'
import { Pin, PinOff, X } from 'lucide-react'
import { apiFetch } from '../../api/client'
import { useMessageStore } from '../../stores/messageStore'
import type { Message } from '../../stores/messageStore'
import MarkdownContent from './MarkdownContent'

interface PinnedEntry {
  id: string
  message: Message
  pinned_by_id: string
  inserted_at: string
}

interface Props {
  channelId: string
  topic: string
  onClose: () => void
}

export default function PinsPanel({ channelId, topic, onClose }: Props): React.JSX.Element {
  const [pins, setPins] = useState<PinnedEntry[]>([])
  const [loading, setLoading] = useState(true)
  const unpinMessage = useMessageStore((s) => s.unpinMessage)

  const fetchPins = async (): Promise<void> => {
    try {
      const res = await apiFetch(`/api/v1/channels/${channelId}/pins`)
      if (res.ok) {
        const data = await res.json()
        setPins(data.pins)
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchPins()
  }, [channelId])

  // Listen for pin/unpin events to refresh
  useEffect(() => {
    const handler = (e: CustomEvent): void => {
      if (e.detail?.channelId === channelId) {
        fetchPins()
      }
    }
    window.addEventListener('pin-update' as string, handler as EventListener)
    return () => window.removeEventListener('pin-update' as string, handler as EventListener)
  }, [channelId])

  const handleUnpin = (messageId: string): void => {
    unpinMessage(topic, messageId)
    setPins((prev) => prev.filter((p) => p.message.id !== messageId))
  }

  return (
    <div className="w-80 border-l border-border bg-bg-primary/80 backdrop-blur-sm flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2 shrink-0">
        <Pin className="w-4 h-4 text-accent" />
        <span className="text-text-primary font-semibold text-sm flex-1">Pinned Messages</span>
        <button
          onClick={onClose}
          className="text-text-faint hover:text-text-primary transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {loading ? (
          <div className="text-text-faintest text-xs text-center py-8">Loading...</div>
        ) : pins.length === 0 ? (
          <div className="text-text-faintest text-xs text-center py-8">
            No pinned messages in this channel
          </div>
        ) : (
          pins.map((pin) => (
            <div
              key={pin.id}
              className="glass-card rounded-lg p-3 group"
            >
              <div className="flex items-baseline gap-2 mb-1">
                <span className="text-text-primary font-medium text-xs">
                  {pin.message.sender?.display_name || pin.message.sender?.username || 'Unknown'}
                </span>
                <span className="text-text-faintest text-[10px]">
                  {new Date(pin.message.inserted_at).toLocaleDateString([], {
                    month: 'short',
                    day: 'numeric'
                  })}
                </span>
                <button
                  onClick={() => handleUnpin(pin.message.id)}
                  className="ml-auto opacity-0 group-hover:opacity-100 text-text-faint hover:text-red-400 transition-all p-0.5 rounded hover:bg-bg-tertiary/50"
                  title="Unpin"
                >
                  <PinOff className="w-3 h-3" />
                </button>
              </div>
              <div className="text-text-secondary text-xs">
                <MarkdownContent content={pin.message.content || ''} />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
