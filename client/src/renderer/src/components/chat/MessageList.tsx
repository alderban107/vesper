import { useEffect, useRef } from 'react'
import { useServerStore } from '../../stores/serverStore'
import { useMessageStore, type Message } from '../../stores/messageStore'
import { useUnreadStore } from '../../stores/unreadStore'
import MessageItem from './MessageItem'

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

  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
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

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  // Mark channel as read when viewing it
  useEffect(() => {
    if (activeChannelId && messages.length > 0) {
      const lastMessage = messages[messages.length - 1]
      markChannelRead(activeChannelId, lastMessage.id)
    }
  }, [activeChannelId, messages.length, markChannelRead])

  const handleScroll = (): void => {
    const container = containerRef.current
    if (!container || !hasMore || !activeChannelId) return

    if (container.scrollTop === 0) {
      fetchOlderMessages(activeChannelId)
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
