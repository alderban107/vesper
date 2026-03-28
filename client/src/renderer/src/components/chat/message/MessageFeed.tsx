import { forwardRef, type HTMLAttributes, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
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
  isThreadView?: boolean
}

const PREPEND_BASE_INDEX = 100_000

const FeedScroller = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function FeedScroller({ className, ...props }, ref) {
    return <div ref={ref} {...props} className={className ? `vesper-message-feed ${className}` : 'vesper-message-feed'} />
  }
)

const FeedList = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function FeedList({ className, ...props }, ref) {
    return <div ref={ref} {...props} className={className ? `vesper-message-feed-inner ${className}` : 'vesper-message-feed-inner'} />
  }
)

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
  isThreadView = false
}: Props): React.JSX.Element {
  const currentUserId = useAuthStore((s) => s.user?.id ?? null)
  const activeChannelId = useServerStore((s) => s.activeChannelId)
  const selectedConversationId = useDmStore((s) => s.selectedConversationId)
  const pendingJumpTarget = useMessageStore((s) => s.pendingJumpTarget)
  const clearPendingJumpTarget = useMessageStore((s) => s.clearPendingJumpTarget)

  const virtuosoRef = useRef<VirtuosoHandle | null>(null)
  const onLoadMoreRef = useRef(onLoadMore)
  const onLoadNewerRef = useRef(onLoadNewer)
  const onMarkReadRef = useRef(onMarkRead)
  const lastJumpRequestIdRef = useRef<number | null>(null)
  const jumpAttemptsRef = useRef(0)
  const highlightTimeoutRef = useRef<number | null>(null)
  const previousMessagesRef = useRef<Message[]>(messages)
  const previousIdentityRef = useRef<string | null>(null)
  const isAtBottomRef = useRef(true)
  const awaitingInitialScrollRef = useRef(false)
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null)
  const [firstItemIndex, setFirstItemIndex] = useState(PREPEND_BASE_INDEX)

  const currentTargetId = selectedConversationId ?? activeChannelId
  const pendingForCurrentTarget = Boolean(
    !isThreadView &&
      pendingJumpTarget &&
      currentTargetId &&
      pendingJumpTarget.targetId === currentTargetId
  )
  const feedIdentity = isThreadView
    ? `thread:${messageLookup?.[0]?.id ?? 'none'}`
    : `scope:${currentTargetId ?? 'none'}`
  const lastMessageId = messages[messages.length - 1]?.id ?? null

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore
  }, [onLoadMore])

  useEffect(() => {
    onLoadNewerRef.current = onLoadNewer
  }, [onLoadNewer])

  useEffect(() => {
    onMarkReadRef.current = onMarkRead
  }, [onMarkRead])

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

  // Scroll anchoring for prepends is handled by Virtuoso's firstItemIndex prop.
  // A previous ResizeObserver-based approach that manually adjusted scrollTop
  // conflicted with Virtuoso's internal scroll management, causing a feedback
  // loop ("scroll thrashing") where the two mechanisms fought each other
  // whenever the user scrolled toward the bottom of a long message list.

  useLayoutEffect(() => {
    if (previousIdentityRef.current !== feedIdentity) {
      previousIdentityRef.current = feedIdentity
      previousMessagesRef.current = messages
      setFirstItemIndex(PREPEND_BASE_INDEX - messages.length)
      setHighlightedMessageId(null)
      jumpAttemptsRef.current = 0
      isAtBottomRef.current = true
      awaitingInitialScrollRef.current = messages.length === 0
      return
    }

    // When messages arrive after a feed identity change, scroll to bottom
    if (awaitingInitialScrollRef.current && messages.length > 0 && !isThreadView) {
      awaitingInitialScrollRef.current = false
      setFirstItemIndex(PREPEND_BASE_INDEX - messages.length)
      previousMessagesRef.current = messages
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({
          index: PREPEND_BASE_INDEX - 1,
          align: 'end',
          behavior: 'auto'
        })
      })
      return
    }

    const previousMessages = previousMessagesRef.current
    const previousFirstId = previousMessages[0]?.id
    const previousLastId = previousMessages[previousMessages.length - 1]?.id
    const nextFirstId = messages[0]?.id
    const nextLastId = messages[messages.length - 1]?.id
    const nextFirstPreviousIndex = nextFirstId
      ? previousMessages.findIndex((message) => message.id === nextFirstId)
      : -1
    const appendedCount =
      previousMessages.length > 0 &&
      nextFirstId === previousFirstId &&
      messages.length > previousMessages.length
        ? messages.length - previousMessages.length
        : 0
    const appendedMessages = appendedCount > 0 ? messages.slice(-appendedCount) : []
    const shouldStickToBottom =
      appendedMessages.length > 0 &&
      (isAtBottomRef.current ||
        appendedMessages.some(
          (message) =>
            String(message.id).startsWith('local:') ||
            message.delivery_state === 'sending' ||
            message.sender_id === currentUserId
        ))

    // Detect deletions — list shrunk without a prepend. Skip scroll adjustments.
    const isDeleteOrShrink =
      previousMessages.length > 0 &&
      messages.length < previousMessages.length &&
      nextFirstId === previousFirstId

    if (isDeleteOrShrink) {
      previousMessagesRef.current = messages
      return
    }

    if (
      previousMessages.length > 0 &&
      nextFirstId &&
      nextFirstId !== previousFirstId &&
      nextFirstPreviousIndex > 0
    ) {
      setFirstItemIndex((value) => value + nextFirstPreviousIndex)
    } else if (
      previousMessages.length > 0 &&
      messages.length > previousMessages.length &&
      previousFirstId &&
      nextFirstId !== previousFirstId &&
      previousLastId === nextLastId
    ) {
      const prependedCount = messages.findIndex((message) => message.id === previousFirstId)
      if (prependedCount > 0) {
        setFirstItemIndex((value) => value - prependedCount)
      }
    }

    if (shouldStickToBottom) {
      const bottomIndex = firstItemIndex + messages.length - 1
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({
          index: bottomIndex,
          align: 'end',
          behavior: 'auto'
        })
      })
    }

    previousMessagesRef.current = messages
  }, [currentUserId, feedIdentity, firstItemIndex, messages])

  useEffect(() => {
    if (pendingForCurrentTarget || !lastMessageId) {
      return
    }

    onMarkReadRef.current(lastMessageId)
  }, [lastMessageId, pendingForCurrentTarget])

  useEffect(() => {
    if (!pendingForCurrentTarget || !pendingJumpTarget || isThreadView) {
      return
    }

    const targetIndex = messages.findIndex((message) => message.id === pendingJumpTarget.messageId)
    if (targetIndex !== -1) {
      virtuosoRef.current?.scrollToIndex({
        index: firstItemIndex + targetIndex,
        align: 'center',
        behavior: 'smooth'
      })
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

  const formatDayLabel = (isoString: string): string => {
    const date = new Date(isoString)
    const now = new Date()
    const yesterday = new Date(now)
    yesterday.setDate(now.getDate() - 1)
    const fullDateLabel = date.toLocaleDateString([], {
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    })

    if (date.toDateString() === now.toDateString()) {
      return fullDateLabel
    }

    if (date.toDateString() === yesterday.toDateString()) {
      return `Yesterday - ${fullDateLabel}`
    }

    return date.toLocaleDateString([], {
      weekday: 'long',
      month: 'long',
      day: 'numeric'
    })
  }

  const lookup = messageLookup ?? messages

  const shouldShowDateDivider = (message: Message, relativeIndex: number): boolean => {
    if (relativeIndex === 0) {
      return true
    }

    const previousMessage = messages[relativeIndex - 1]
    if (!previousMessage) {
      return true
    }

    return new Date(message.inserted_at).toDateString() !== new Date(previousMessage.inserted_at).toDateString()
  }

  const followOutput = useMemo(
    () =>
      (atBottom: boolean): 'auto' | false =>
        !pendingForCurrentTarget && atBottom ? 'auto' : false,
    [pendingForCurrentTarget]
  )



  return (
    messages.length === 0 ? (
      <div className="vesper-message-feed">
        {isLoading ? (
          <MessageSkeleton />
        ) : (
          <div className="vesper-message-empty-state">
            <p>{emptyState}</p>
          </div>
        )}
        <TypingIndicator typingUsers={typingUsers} />
      </div>
    ) : (
      <Virtuoso
        ref={virtuosoRef}
        data={messages}
        alignToBottom={!isThreadView}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={isThreadView ? firstItemIndex : Math.max(firstItemIndex + messages.length - 1, firstItemIndex)}
        followOutput={isThreadView ? false : followOutput}
        atBottomThreshold={96}
        atBottomStateChange={(atBottom) => {
          isAtBottomRef.current = atBottom
        }}
        startReached={() => {
          if (hasMore) {
            onLoadMoreRef.current()
          }
        }}
        endReached={() => {
          if (hasNewer) {
            onLoadNewerRef.current()
          }
        }}
        increaseViewportBy={{ top: 600, bottom: 800 }}
        minOverscanItemCount={{ top: 6, bottom: 10 }}
        computeItemKey={(_index, message) => message.id}
        className="vesper-message-feed-root"
        components={{
          Scroller: FeedScroller,
          List: FeedList,
          Footer: () => <TypingIndicator typingUsers={typingUsers} />
        }}
        itemContent={(index, message) => {
          const relativeIndex = index - firstItemIndex
          const previousMessage = relativeIndex > 0 ? messages[relativeIndex - 1] : null

          return (
            <div
              data-message-id={message.id}
              className={highlightedMessageId === message.id ? 'vesper-message-jump-target' : undefined}
            >
              {shouldShowDateDivider(message, relativeIndex) && (
                <DateDivider label={formatDayLabel(message.inserted_at)} />
              )}
              <MessageItem
                message={message}
                messages={lookup}
                previousMessage={previousMessage}
                isThreadView={isThreadView}
              />
            </div>
          )
        }}
      />
    )
  )
}
