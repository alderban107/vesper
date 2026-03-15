import { useEffect, useRef, useState } from 'react'
import { Loader2, Pin, PinOff } from 'lucide-react'
import {
  parseMessageContent,
  useMessageStore,
  type PinnedMessageEntry
} from '../../stores/messageStore'

interface Props {
  channelId: string
  topic: string
  canManage: boolean
  onClose: () => void
}

export default function PinnedMessagesPopover({
  channelId,
  topic,
  canManage,
  onClose
}: Props): React.JSX.Element {
  const fetchPinnedMessages = useMessageStore((s) => s.fetchPinnedMessages)
  const jumpToMessage = useMessageStore((s) => s.jumpToMessage)
  const unpinMessage = useMessageStore((s) => s.unpinMessage)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pins, setPins] = useState<PinnedMessageEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [jumpingMessageId, setJumpingMessageId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refreshPins = async (): Promise<void> => {
    const nextPins = await fetchPinnedMessages(channelId)
    setPins(nextPins)
    setLoading(false)
  }

  useEffect(() => {
    void refreshPins()
  }, [channelId])

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent): void => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        onClose()
      }
    }

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('mousedown', handleOutsideClick)
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('mousedown', handleOutsideClick)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  useEffect(() => {
    const onPinUpdate = (event: Event): void => {
      const customEvent = event as CustomEvent<{ channelId?: string }>
      if (customEvent.detail?.channelId === channelId) {
        void refreshPins()
      }
    }

    window.addEventListener('pin-update', onPinUpdate as EventListener)
    return () => window.removeEventListener('pin-update', onPinUpdate as EventListener)
  }, [channelId])

  const handleJump = async (pin: PinnedMessageEntry): Promise<void> => {
    setError(null)
    setJumpingMessageId(pin.message.id)
    const ok = await jumpToMessage(channelId, pin.message.id, pin.message.inserted_at)
    setJumpingMessageId(null)

    if (ok) {
      onClose()
    } else {
      setError('Message could not be located in history.')
    }
  }

  const handleUnpin = (messageId: string): void => {
    unpinMessage(topic, messageId)
    setPins((currentPins) => currentPins.filter((pin) => pin.message.id !== messageId))
    window.setTimeout(() => {
      void refreshPins()
    }, 400)
  }

  const messagePreview = (pin: PinnedMessageEntry): string => {
    if (pin.message.decryptionFailed || pin.message.content === 'Message unavailable') {
      return 'Encrypted message'
    }

    const parsed = parseMessageContent(pin.message.content || '')
    if (parsed.type === 'file') {
      return parsed.text || `File: ${parsed.file.name}`
    }

    return parsed.text || 'Message'
  }

  return (
    <div
      data-testid="pins-panel"
      ref={popoverRef}
      className="absolute right-0 top-10 z-40 w-96 max-w-[80vw] rounded-xl border border-border bg-bg-secondary/95 p-2 shadow-2xl backdrop-blur"
    >
      <div className="flex items-center gap-2 px-2 py-1.5">
        <Pin className="w-4 h-4 text-accent" />
        <span className="text-text-primary text-sm font-semibold">Pinned Messages</span>
      </div>

      <div className="max-h-80 overflow-y-auto space-y-1 px-1 pb-1">
        {loading ? (
          <div className="py-8 flex items-center justify-center text-text-faint text-xs">
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
            Loading pins
          </div>
        ) : pins.length === 0 ? (
          <div className="py-8 text-center text-text-faint text-xs">No pinned messages</div>
        ) : (
          pins.map((pin) => (
            <div
              data-testid="pinned-message"
              key={pin.id}
              className="rounded-lg border border-border/60 bg-bg-primary/70 px-2.5 py-2"
            >
              <div className="flex items-center gap-2">
                <span className="text-text-primary text-xs font-medium truncate">
                  {pin.message.sender?.display_name || pin.message.sender?.username || 'Unknown'}
                </span>
                <span className="text-text-faintest text-[10px] shrink-0">
                  {new Date(pin.message.inserted_at).toLocaleDateString([], {
                    month: 'short',
                    day: 'numeric'
                  })}
                </span>
                {canManage && (
                  <button
                    type="button"
                    className="ml-auto text-text-faint hover:text-red-400 transition-colors p-1 rounded hover:bg-bg-tertiary/50"
                    title="Unpin message"
                    onClick={() => handleUnpin(pin.message.id)}
                  >
                    <PinOff className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <button
                type="button"
                className="mt-1 w-full text-left text-text-secondary hover:text-text-primary text-xs leading-relaxed"
                disabled={jumpingMessageId === pin.message.id}
                onClick={() => {
                  void handleJump(pin)
                }}
              >
                {messagePreview(pin)}
              </button>
            </div>
          ))
        )}
      </div>

      {error && (
        <div className="px-2 pb-1 pt-1 text-[11px] text-red-300">{error}</div>
      )}
    </div>
  )
}
