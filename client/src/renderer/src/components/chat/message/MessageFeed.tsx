import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useMessageStore, type Message } from '../../../stores/messageStore'
import MessageSkeleton from './MessageSkeleton'
import { useAuthStore } from '../../../stores/authStore'
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
  isLoading?: boolean
  hasMore: boolean
  hasNewer: boolean
  emptyState: string
  onLoadMore: () => void
  onLoadNewer: () => void
  onMarkRead: (messageId: string) => void
  onIsAtBottomChange?: (isAtBottom: boolean) => void
  isThreadView?: boolean
}

const AT_BOTTOM_THRESHOLD = 96
const LOAD_MORE_THRESHOLD = 300

export default function MessageFeed({
  messages,
  messageLookup,
  typingUsers,
  isLoading = false,
  hasMore,
  hasNewer,
  emptyState,
  onLoadMore,
  onLoadNewer,
  onMarkRead,
  onIsAtBottomChange,
  isThreadView = false,
}: Props): React.JSX.Element {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  const wasAtBottomBeforeUpdate = useRef(true)
  const loadMoreLockRef = useRef(false)
  const loadNewerLockRef = useRef(false)
  const previousMessagesLenRef = useRef(messages.length)
  const previousLastIdRef = useRef<string | null>(null)
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null)
  const highlightTimeoutRef = useRef<number | null>(null)
  const [newMessageCount, setNewMessageCount] = useState(0)

  const currentUserId = useAuthStore((s) => s.user?.id)
  const activeChannelId = useServerStore((s) => s.activeChannelId)
  const selectedConversationId = useDmStore((s) => s.selectedConversationId)
  const pendingJumpTarget = useMessageStore((s) => s.pendingJumpTarget)
  const clearPendingJumpTarget = useMessageStore((s) => s.clearPendingJumpTarget)

  const onLoadMoreRef = useRef(onLoadMore)
  const onLoadNewerRef = useRef(onLoadNewer)
  const onMarkReadRef = useRef(onMarkRead)
  useEffect(() => { onLoadMoreRef.current = onLoadMore }, [onLoadMore])
  useEffect(() => { onLoadNewerRef.current = onLoadNewer }, [onLoadNewer])
  useEffect(() => { onMarkReadRef.current = onMarkRead }, [onMarkRead])

  const lastMessageId = messages.length > 0 ? messages[messages.length - 1]?.id : null

  // --- Check if at bottom ---
  const checkIsAtBottom = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return true
    // For column-reverse, scrollTop is 0 at bottom and negative when scrolled up
    return Math.abs(el.scrollTop) < AT_BOTTOM_THRESHOLD
  }, [])

  // --- Scroll handler ---
  const handleScroll = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return

    const atBottom = checkIsAtBottom()
    if (atBottom !== isAtBottomRef.current) {
      isAtBottomRef.current = atBottom
      onIsAtBottomChange?.(atBottom)
      if (atBottom) {
        setNewMessageCount(0)
      }
    }

    // Load older messages when scrolled near the top
    // In column-reverse, "top" is when scrollTop is at its most negative
    const scrollableHeight = el.scrollHeight - el.clientHeight
    const distanceFromTop = scrollableHeight - Math.abs(el.scrollTop)
    if (distanceFromTop < LOAD_MORE_THRESHOLD && hasMore && !loadMoreLockRef.current) {
      loadMoreLockRef.current = true
      onLoadMoreRef.current()
      setTimeout(() => { loadMoreLockRef.current = false }, 500)
    }

    // Load newer messages when near bottom and hasNewer
    if (Math.abs(el.scrollTop) < LOAD_MORE_THRESHOLD && hasNewer && !loadNewerLockRef.current) {
      loadNewerLockRef.current = true
      onLoadNewerRef.current()
      setTimeout(() => { loadNewerLockRef.current = false }, 500)
    }
  }, [checkIsAtBottom, hasMore, hasNewer, onIsAtBottomChange])

  // --- Capture scroll position before React updates ---
  // Record whether we were at bottom before the messages array changes
  useLayoutEffect(() => {
    wasAtBottomBeforeUpdate.current = isAtBottomRef.current
  })

  // --- After messages update: track new messages for the bar ---
  useLayoutEffect(() => {
    const prevLen = previousMessagesLenRef.current
    const prevLastId = previousLastIdRef.current
    const nextLastId = messages.length > 0 ? messages[messages.length - 1]?.id : null

    previousMessagesLenRef.current = messages.length
    previousLastIdRef.current = nextLastId ?? null

    // If new messages were appended (last ID changed, length grew) and we're not at bottom
    if (
      prevLastId &&
      nextLastId &&
      nextLastId !== prevLastId &&
      messages.length >= prevLen &&
      !isAtBottomRef.current
    ) {
      const appendedCount = messages.length - prevLen
      if (appendedCount > 0) {
        setNewMessageCount((c) => c + appendedCount)
      }
    }
  }, [messages])

  // --- Mark as read ---
  useEffect(() => {
    if (lastMessageId) {
      onMarkReadRef.current(lastMessageId)
    }
  }, [lastMessageId])

  // --- Jump to message ---
  useEffect(() => {
    if (!pendingJumpTarget || isThreadView) return

    const currentTargetId = selectedConversationId ?? activeChannelId
    if (!currentTargetId || pendingJumpTarget.targetId !== currentTargetId) return

    const targetEl = scrollerRef.current?.querySelector(
      `[data-message-id="${pendingJumpTarget.messageId}"]`
    )
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setHighlightedMessageId(pendingJumpTarget.messageId)
      if (highlightTimeoutRef.current !== null) {
        window.clearTimeout(highlightTimeoutRef.current)
      }
      highlightTimeoutRef.current = window.setTimeout(() => {
        setHighlightedMessageId((current) =>
          current === pendingJumpTarget.messageId ? null : current
        )
      }, 2200)
      clearPendingJumpTarget()
    }
  }, [pendingJumpTarget, activeChannelId, selectedConversationId, clearPendingJumpTarget, isThreadView])

  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current !== null) {
        window.clearTimeout(highlightTimeoutRef.current)
      }
    }
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = 0 // column-reverse: 0 is the bottom
    setNewMessageCount(0)
  }, [])

  // --- Date divider logic ---
  function shouldShowDateDivider(message: Message, index: number): boolean {
    if (index === 0) return true
    const previousMessage = messages[index - 1]
    if (!previousMessage) return false
    return new Date(message.inserted_at).toDateString() !== new Date(previousMessage.inserted_at).toDateString()
  }

  function formatDayLabel(isoString: string): string {
    const date = new Date(isoString)
    const now = new Date()
    const isToday = date.toDateString() === now.toDateString()
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    const isYesterday = date.toDateString() === yesterday.toDateString()

    if (isToday) return 'Today'
    if (isYesterday) return 'Yesterday'
    return date.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  }

  // --- Loading state ---
  if (isLoading) {
    return (
      <div className="vesper-message-feed">
        <MessageSkeleton />
      </div>
    )
  }

  // --- Empty state ---
  if (messages.length === 0) {
    return (
      <div className="vesper-message-feed vesper-message-feed-empty">
        <div className="vesper-message-feed-empty-text">
          <p>{emptyState}</p>
        </div>
        <TypingIndicator typingUsers={typingUsers} />
      </div>
    )
  }

  // --- Message list ---
  return (
    <div
      ref={scrollerRef}
      className="vesper-message-feed-scroller"
      onScroll={handleScroll}
    >
      <div ref={contentRef} className="vesper-message-feed-content">
        {hasMore && (
          <div className="vesper-message-feed-load-more">
            <MessageSkeleton />
          </div>
        )}
        {messages.map((message, index) => {
          const previousMessage = index > 0 ? messages[index - 1] : null

          return (
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
                previousMessage={previousMessage}
                isThreadView={isThreadView}
              />
            </div>
          )
        })}
      </div>
      <TypingIndicator typingUsers={typingUsers} />
      {newMessageCount > 0 && !isAtBottomRef.current && (
        <button
          type="button"
          className="vesper-new-messages-bar"
          onClick={scrollToBottom}
        >
          <span>{newMessageCount} new {newMessageCount === 1 ? 'message' : 'messages'}</span>
          <span className="vesper-new-messages-bar-action">Jump to bottom</span>
        </button>
      )}
    </div>
  )
}
