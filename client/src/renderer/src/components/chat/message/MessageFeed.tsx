import { useEffect, useRef } from 'react'
import type { Message } from '../../../stores/messageStore'
import MessageItem from '../MessageItem'
import DateDivider from './DateDivider'

interface TypingUser {
  user_id: string
  username: string
}

interface Props {
  messages: Message[]
  typingUsers: TypingUser[]
  hasMore: boolean
  emptyState: string
  onLoadMore: () => void
  onMarkRead: (messageId: string) => void
}

export default function MessageFeed({
  messages,
  typingUsers,
  hasMore,
  emptyState,
  onLoadMore,
  onMarkRead
}: Props): React.JSX.Element {
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  useEffect(() => {
    const lastMessage = messages[messages.length - 1]
    if (lastMessage) {
      onMarkRead(lastMessage.id)
    }
  }, [messages, onMarkRead])

  const handleScroll = (): void => {
    const container = containerRef.current
    if (!container || !hasMore) {
      return
    }

    if (container.scrollTop === 0) {
      onLoadMore()
    }
  }

  const formatDayLabel = (isoString: string): string => {
    const date = new Date(isoString)
    const now = new Date()
    const yesterday = new Date(now)
    yesterday.setDate(now.getDate() - 1)

    if (date.toDateString() === now.toDateString()) {
      return 'Today'
    }

    if (date.toDateString() === yesterday.toDateString()) {
      return 'Yesterday'
    }

    return date.toLocaleDateString([], {
      weekday: 'long',
      month: 'long',
      day: 'numeric'
    })
  }

  const shouldShowDateDivider = (message: Message, index: number): boolean => {
    if (index === 0) {
      return true
    }

    return new Date(message.inserted_at).toDateString() !== new Date(messages[index - 1].inserted_at).toDateString()
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="vesper-message-feed"
    >
      {messages.length === 0 ? (
        <div className="vesper-message-empty-state">
          <p>{emptyState}</p>
        </div>
      ) : (
        <div className="vesper-message-feed-inner">
          {messages.map((message, index) => (
            <div key={message.id}>
              {shouldShowDateDivider(message, index) && (
                <DateDivider label={formatDayLabel(message.inserted_at)} />
              )}
              <MessageItem
                message={message}
                messages={messages}
                previousMessage={index > 0 ? messages[index - 1] : null}
              />
            </div>
          ))}
        </div>
      )}

      {typingUsers.length > 0 && (
        <div className="vesper-typing-indicator">
          {typingUsers.map((user) => user.username).join(', ')} {typingUsers.length === 1 ? 'is' : 'are'} typing...
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  )
}
