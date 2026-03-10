import { useEffect, useRef } from 'react'
import { useDmStore } from '../../stores/dmStore'
import { useMessageStore, type Message } from '../../stores/messageStore'
import { useUnreadStore } from '../../stores/unreadStore'
import MessageFeed from '../chat/message/MessageFeed'

const EMPTY_MESSAGES: Message[] = []
const EMPTY_TYPING: { user_id: string; username: string }[] = []

export default function DmMessageList(): React.JSX.Element {
  const conversationId = useDmStore((s) => s.selectedConversationId)
  const messages = useMessageStore((s) =>
    conversationId ? (s.messagesByChannel[conversationId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  )
  const typingUsers = useMessageStore((s) =>
    conversationId ? (s.typingUsers[conversationId] ?? EMPTY_TYPING) : EMPTY_TYPING
  )
  const hasMore = useMessageStore((s) =>
    conversationId ? s.hasMore[conversationId] ?? true : false
  )
  const joinDmChat = useMessageStore((s) => s.joinDmChat)
  const leaveDmChat = useMessageStore((s) => s.leaveDmChat)
  const fetchOlderDmMessages = useMessageStore((s) => s.fetchOlderDmMessages)
  const markDmRead = useUnreadStore((s) => s.markDmRead)

  const prevConvRef = useRef<string | null>(null)

  useEffect(() => {
    if (prevConvRef.current) {
      leaveDmChat(prevConvRef.current)
    }
    if (conversationId) {
      joinDmChat(conversationId)
    }
    prevConvRef.current = conversationId
  }, [conversationId, joinDmChat, leaveDmChat])

  const handleLoadMore = (): void => {
    if (hasMore && conversationId) {
      fetchOlderDmMessages(conversationId)
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
        if (conversationId) {
          markDmRead(conversationId, messageId)
        }
      }}
    />
  )
}
