import { useEffect, useMemo, useRef } from 'react'
import { useServerStore } from '../../stores/serverStore'
import { useMessageStore, type Message } from '../../stores/messageStore'
import { useUnreadStore } from '../../stores/unreadStore'
import MessageFeed from './message/MessageFeed'

const EMPTY_MESSAGES: Message[] = []
const EMPTY_TYPING: { user_id: string; username: string }[] = []

export default function MessageList(): React.JSX.Element {
  const activeChannelId = useServerStore((s) => s.activeChannelId)
  const allMessages = useMessageStore((s) =>
    activeChannelId ? (s.messagesByChannel[activeChannelId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  )
  const messages = useMemo(
    () => allMessages.filter((message) => !message.parent_message_id),
    [allMessages]
  )
  const typingUsers = useMessageStore((s) =>
    activeChannelId ? (s.typingUsers[activeChannelId] ?? EMPTY_TYPING) : EMPTY_TYPING
  )
  const isLoading = useMessageStore((s) =>
    activeChannelId ? (s.loadingByScope[activeChannelId] ?? false) : false
  )
  const hasLoaded = useMessageStore((s) =>
    activeChannelId ? (s.loadedByScope[activeChannelId] ?? false) : false
  )
  const hasMore = useMessageStore((s) =>
    activeChannelId ? s.hasMore[activeChannelId] ?? true : false
  )
  const hasNewer = useMessageStore((s) =>
    activeChannelId ? s.hasNewer[activeChannelId] ?? false : false
  )
  const joinChannelChat = useMessageStore((s) => s.joinChannelChat)
  const leaveChannelChat = useMessageStore((s) => s.leaveChannelChat)
  const activateScope = useMessageStore((s) => s.activateScope)
  const fetchOlderMessages = useMessageStore((s) => s.fetchOlderMessages)
  const fetchNewerMessages = useMessageStore((s) => s.fetchNewerMessages)
  const markChannelRead = useUnreadStore((s) => s.markChannelRead)

  const prevChannelRef = useRef<string | null>(null)

  // Join/leave channel when activeChannelId changes
  useEffect(() => {
    if (prevChannelRef.current) {
      leaveChannelChat(prevChannelRef.current)
    }
    if (activeChannelId) {
      activateScope(activeChannelId, 'channel')
      joinChannelChat(activeChannelId)
    }
    prevChannelRef.current = activeChannelId
  }, [activeChannelId, activateScope, joinChannelChat, leaveChannelChat])

  const handleLoadMore = (): void => {
    if (hasMore && activeChannelId) {
      fetchOlderMessages(activeChannelId)
    }
  }

  const handleLoadNewer = (): void => {
    if (hasNewer && activeChannelId) {
      fetchNewerMessages(activeChannelId)
    }
  }

  return (
    <MessageFeed
      messages={messages}
      messageLookup={allMessages}
      typingUsers={typingUsers}
      isLoading={Boolean(activeChannelId) && (!hasLoaded || isLoading)}
      hasMore={hasMore}
      hasNewer={hasNewer}
      emptyState="No messages yet. Say something!"
      onLoadMore={handleLoadMore}
      onLoadNewer={handleLoadNewer}
      onMarkRead={(messageId) => {
        if (activeChannelId) {
          markChannelRead(activeChannelId, messageId)
        }
      }}
    />
  )
}
