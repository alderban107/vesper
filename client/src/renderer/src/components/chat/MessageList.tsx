import { useEffect, useMemo, useRef } from 'react'
import { useServerStore } from '../../stores/serverStore'
import { useDmStore } from '../../stores/dmStore'
import { useMessageStore, type Message } from '../../stores/messageStore'
import { useUnreadStore } from '../../stores/unreadStore'
import MessageFeed from './message/MessageFeed'

const EMPTY_MESSAGES: Message[] = []
const EMPTY_TYPING: { user_id: string; username: string }[] = []

interface Props {
  scope: { kind: 'channel'; id: string } | { kind: 'dm'; id: string }
}

export default function MessageList({ scope }: Props): React.JSX.Element {
  const scopeId = scope.id
  const allMessages = useMessageStore((s) =>
    s.messagesByChannel[scopeId] ?? EMPTY_MESSAGES
  )
  const messages = useMemo(
    () => allMessages.filter((message) => !message.parent_message_id),
    [allMessages]
  )
  const typingUsers = useMessageStore((s) =>
    s.typingUsers[scopeId] ?? EMPTY_TYPING
  )
  const isLoading = useMessageStore((s) =>
    s.loadingByScope[scopeId] ?? false
  )
  const hasLoaded = useMessageStore((s) =>
    s.loadedByScope[scopeId] ?? false
  )
  const hasMore = useMessageStore((s) =>
    s.hasMore[scopeId] ?? true
  )
  const hasNewer = useMessageStore((s) =>
    s.hasNewer[scopeId] ?? false
  )

  const joinChannelChat = useMessageStore((s) => s.joinChannelChat)
  const leaveChannelChat = useMessageStore((s) => s.leaveChannelChat)
  const joinDmChat = useMessageStore((s) => s.joinDmChat)
  const leaveDmChat = useMessageStore((s) => s.leaveDmChat)
  const activateScope = useMessageStore((s) => s.activateScope)
  const fetchOlderMessages = useMessageStore((s) => s.fetchOlderMessages)
  const fetchNewerMessages = useMessageStore((s) => s.fetchNewerMessages)
  const fetchOlderDmMessages = useMessageStore((s) => s.fetchOlderDmMessages)
  const fetchNewerDmMessages = useMessageStore((s) => s.fetchNewerDmMessages)
  const markChannelRead = useUnreadStore((s) => s.markChannelRead)
  const markDmRead = useUnreadStore((s) => s.markDmRead)

  const prevScopeRef = useRef<string | null>(null)

  useEffect(() => {
    const leave = scope.kind === 'channel' ? leaveChannelChat : leaveDmChat
    const join = scope.kind === 'channel' ? joinChannelChat : joinDmChat

    if (prevScopeRef.current) {
      leave(prevScopeRef.current)
    }
    activateScope(scopeId, scope.kind)
    join(scopeId)
    prevScopeRef.current = scopeId
  }, [activateScope, joinChannelChat, joinDmChat, leaveChannelChat, leaveDmChat, scope.kind, scopeId])

  const handleLoadMore = (): void => {
    if (hasMore) {
      const fetch = scope.kind === 'channel' ? fetchOlderMessages : fetchOlderDmMessages
      fetch(scopeId)
    }
  }

  const handleLoadNewer = (): void => {
    if (hasNewer) {
      const fetch = scope.kind === 'channel' ? fetchNewerMessages : fetchNewerDmMessages
      fetch(scopeId)
    }
  }

  return (
    <MessageFeed
      messages={messages}
      messageLookup={allMessages}
      typingUsers={typingUsers}
      isLoading={!hasLoaded || isLoading}
      hasMore={hasMore}
      hasNewer={hasNewer}
      emptyState="No messages yet. Say something!"
      onLoadMore={handleLoadMore}
      onLoadNewer={handleLoadNewer}
      onMarkRead={(messageId) => {
        if (scope.kind === 'channel') {
          if (useServerStore.getState().activeChannelId === scopeId) {
            markChannelRead(scopeId, messageId)
          }
        } else {
          if (useDmStore.getState().selectedConversationId === scopeId) {
            markDmRead(scopeId, messageId)
          }
        }
      }}
    />
  )
}
