import { useEffect, useRef } from 'react'
import { useDmStore } from '../../stores/dmStore'
import { useMessageStore, type Message } from '../../stores/messageStore'
import { useUnreadStore } from '../../stores/unreadStore'
import MessageItem from '../chat/MessageItem'

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

  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  // Mark DM as read when viewing it
  useEffect(() => {
    if (conversationId && messages.length > 0) {
      const lastMessage = messages[messages.length - 1]
      markDmRead(conversationId, lastMessage.id)
    }
  }, [conversationId, messages.length, markDmRead])

  const handleScroll = (): void => {
    const container = containerRef.current
    if (!container || !hasMore || !conversationId) return

    if (container.scrollTop === 0) {
      fetchOlderDmMessages(conversationId)
    }
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto px-4 py-2"
    >
      {messages.length === 0 ? (
        <div className="flex items-center justify-center h-full text-text-faintest">
          <p>No messages yet. Say something!</p>
        </div>
      ) : (
        messages.map((msg) => <MessageItem key={msg.id} message={msg} messages={messages} />)
      )}

      {typingUsers.length > 0 && (
        <div className="text-text-faint text-sm py-1 animate-pulse">
          {typingUsers.map((t) => t.username).join(', ')}{' '}
          {typingUsers.length === 1 ? 'is' : 'are'} typing...
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  )
}
