import { useEffect, useRef, useState } from 'react'
import { useMessageStore, type Message } from '../../../stores/messageStore'
import { useServerStore } from '../../../stores/serverStore'
import { useDmStore } from '../../../stores/dmStore'
import MessageItem from '../MessageItem'
import DateDivider from './DateDivider'
import TypingIndicator from './TypingIndicator'

interface TypingUser {
  user_id: string
  username: string
}

interface Props {
  messages: Message[]
  messageLookup?: Message[]
  typingUsers: TypingUser[]
  hasMore: boolean
  emptyState: string
  onLoadMore: () => void
  onMarkRead: (messageId: string) => void
  isThreadView?: boolean
}

export default function MessageFeed({
  messages,
  messageLookup,
  typingUsers,
  hasMore,
  emptyState,
  onLoadMore,
  onMarkRead,
  isThreadView = false
}: Props): React.JSX.Element {
  const activeChannelId = useServerStore((s) => s.activeChannelId)
  const selectedConversationId = useDmStore((s) => s.selectedConversationId)
  const pendingJumpTarget = useMessageStore((s) => s.pendingJumpTarget)
  const clearPendingJumpTarget = useMessageStore((s) => s.clearPendingJumpTarget)

  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const onLoadMoreRef = useRef(onLoadMore)
  const lastJumpRequestIdRef = useRef<number | null>(null)
  const jumpAttemptsRef = useRef(0)
  const highlightTimeoutRef = useRef<number | null>(null)
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null)

  const currentTargetId = selectedConversationId ?? activeChannelId
  const pendingForCurrentTarget = Boolean(
    !isThreadView &&
      pendingJumpTarget &&
      currentTargetId &&
      pendingJumpTarget.targetId === currentTargetId
  )

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore
  }, [onLoadMore])

  useEffect(() => {
    const nextRequestId = pendingJumpTarget?.requestId ?? null
    if (lastJumpRequestIdRef.current !== nextRequestId) {
      jumpAttemptsRef.current = 0
      lastJumpRequestIdRef.current = nextRequestId
    }
  }, [pendingJumpTarget?.requestId])

  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current !== null) {
        window.clearTimeout(highlightTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (pendingForCurrentTarget) {
      return
    }
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, pendingForCurrentTarget])

  useEffect(() => {
    if (pendingForCurrentTarget) {
      return
    }

    const lastMessage = messages[messages.length - 1]
    if (lastMessage) {
      onMarkRead(lastMessage.id)
    }
  }, [messages, onMarkRead, pendingForCurrentTarget])

  useEffect(() => {
    if (!pendingForCurrentTarget || !pendingJumpTarget || isThreadView) {
      return
    }

    const messageExists = messages.some((message) => message.id === pendingJumpTarget.messageId)
    if (messageExists) {
      const container = containerRef.current
      const targetElement = container?.querySelector<HTMLElement>(
        `[data-message-id="${pendingJumpTarget.messageId}"]`
      )

      if (targetElement) {
        targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
        if (highlightTimeoutRef.current !== null) {
          window.clearTimeout(highlightTimeoutRef.current)
        }
        setHighlightedMessageId(pendingJumpTarget.messageId)
        highlightTimeoutRef.current = window.setTimeout(() => {
          setHighlightedMessageId((current) =>
            current === pendingJumpTarget.messageId ? null : current
          )
          highlightTimeoutRef.current = null
        }, 2200)
        clearPendingJumpTarget()
        jumpAttemptsRef.current = 0
      }
      return
    }

    if (!hasMore || jumpAttemptsRef.current >= 30) {
      clearPendingJumpTarget()
      jumpAttemptsRef.current = 0
      return
    }

    jumpAttemptsRef.current += 1
    onLoadMoreRef.current()
  }, [
    clearPendingJumpTarget,
    hasMore,
    isThreadView,
    messages,
    pendingForCurrentTarget,
    pendingJumpTarget
  ])

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
            <div
              key={message.id}
              data-message-id={message.id}
              className={highlightedMessageId === message.id ? 'vesper-message-jump-target' : undefined}
            >
              {shouldShowDateDivider(message, index) && (
                <DateDivider label={formatDayLabel(message.inserted_at)} />
              )}
              <MessageItem
                message={message}
                messages={messageLookup ?? messages}
                previousMessage={index > 0 ? messages[index - 1] : null}
              />
            </div>
          ))}
        </div>
      )}

      <TypingIndicator typingUsers={typingUsers} />

      <div ref={bottomRef} />
    </div>
  )
}
