import { useCallback, useEffect, useRef } from 'react'
import { useServerStore } from '../../stores/serverStore'
import { useDmStore } from '../../stores/dmStore'
import {
  resolveDmChannelId,
  useMessageStore,
  type Message
} from '../../stores/messageStore'
import { useUnreadStore } from '../../stores/unreadStore'
import MessageFeed from './message/MessageFeed'

const EMPTY_MESSAGES: Message[] = []
const EMPTY_TYPING: { user_id: string; username: string }[] = []


interface Props {
  scope: { kind: 'channel'; id: string } | { kind: 'dm'; id: string }
}

export default function MessageList({ scope }: Props): React.JSX.Element {
  useDmStore((s) => s.conversations)
  const dmChannelId = scope.kind === 'dm' ? resolveDmChannelId(scope.id) : null

  const resolvedScope = scope.kind === 'dm' && dmChannelId
    ? { kind: 'channel' as const, id: dmChannelId }
    : scope

  const scopeId = resolvedScope.id
  const allMessages = useMessageStore((s) =>
    s.messagesByChannel[scopeId] ?? EMPTY_MESSAGES
  )
  const messages = allMessages
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
  const setIsAtBottom = useMessageStore((s) => s.setIsAtBottom)
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
    const joinId = scope.id

    if (prevScopeRef.current) {
      leave(prevScopeRef.current)
    }
    activateScope(scopeId, resolvedScope.kind)
    join(joinId)
    prevScopeRef.current = joinId
  }, [activateScope, joinChannelChat, joinDmChat, leaveChannelChat, leaveDmChat, resolvedScope.kind, scope.id, scope.kind, scopeId])

  const handleLoadMore = (): void => {
    if (hasMore) {
      const fetch = resolvedScope.kind === 'channel' ? fetchOlderMessages : fetchOlderDmMessages
      fetch(scopeId)
    }
  }

  const handleLoadNewer = (): void => {
    if (hasNewer) {
      const fetch = resolvedScope.kind === 'channel' ? fetchNewerMessages : fetchNewerDmMessages
      fetch(scopeId)
    }
  }

  const handleIsAtBottomChange = useCallback((isAtBottom: boolean) => {
    setIsAtBottom(scopeId, isAtBottom)
  }, [scopeId, setIsAtBottom])

  return (
    <MessageFeed
      messages={messages}
      messageLookup={allMessages}
      typingUsers={typingUsers}
      isLoading={messages.length === 0 && (!hasLoaded || isLoading)}
      hasMore={hasMore}
      hasNewer={hasNewer}
      emptyState={scope.kind === 'dm' ? 'This is the start of your conversation.' : 'No messages yet.'}
      onLoadMore={handleLoadMore}
      onLoadNewer={handleLoadNewer}
      onIsAtBottomChange={handleIsAtBottomChange}
      onMarkRead={(messageId) => {
        if (scope.kind === 'channel') {
          if (useServerStore.getState().activeChannelId === scopeId) {
            markChannelRead(scopeId, messageId)
          }
        } else {
          if (useDmStore.getState().selectedConversationId === scope.id) {
            markDmRead(scope.id, messageId)
          }
        }
      }}
    />
  )
}
