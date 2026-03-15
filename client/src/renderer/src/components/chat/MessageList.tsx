import { useEffect, useRef } from 'react'
import { useServerStore } from '../../stores/serverStore'
import { useMessageStore, type Message } from '../../stores/messageStore'
import { useUnreadStore } from '../../stores/unreadStore'
import MessageFeed from './message/MessageFeed'

const EMPTY_MESSAGES: Message[] = []
const EMPTY_TYPING: { user_id: string; username: string }[] = []

export default function MessageList(): React.JSX.Element {
  const activeChannelId = useServerStore((s) => s.activeChannelId)
  const messages = useMessageStore((s) =>
    activeChannelId ? (s.messagesByChannel[activeChannelId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  )
  const typingUsers = useMessageStore((s) =>
    activeChannelId ? (s.typingUsers[activeChannelId] ?? EMPTY_TYPING) : EMPTY_TYPING
  )
  const hasMore = useMessageStore((s) =>
    activeChannelId ? s.hasMore[activeChannelId] ?? true : false
  )
  const joinChannelChat = useMessageStore((s) => s.joinChannelChat)
  const leaveChannelChat = useMessageStore((s) => s.leaveChannelChat)
  const fetchOlderMessages = useMessageStore((s) => s.fetchOlderMessages)
  const markChannelRead = useUnreadStore((s) => s.markChannelRead)

  const prevChannelRef = useRef<string | null>(null)

  // Join/leave channel when activeChannelId changes
  useEffect(() => {
    if (prevChannelRef.current) {
      leaveChannelChat(prevChannelRef.current)
    }
    if (activeChannelId) {
      joinChannelChat(activeChannelId)
    }
    prevChannelRef.current = activeChannelId
  }, [activeChannelId, joinChannelChat, leaveChannelChat])

  const handleLoadMore = (): void => {
    if (hasMore && activeChannelId) {
      fetchOlderMessages(activeChannelId)
    }
  }

  return (
    <MessageFeed
      messages={messages}
      typingUsers={typingUsers}
      hasMore={hasMore}
      emptyState="No messages yet. Say something!"
      onLoadMore={handleLoadMore}
      onMarkRead={(messageId) => {
        if (activeChannelId) {
          markChannelRead(activeChannelId, messageId)
        }
      }}
    />
  )
}
