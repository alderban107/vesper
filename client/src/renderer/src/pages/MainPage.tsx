import { useEffect, useState } from 'react'
import { SendHorizonal, Star, X } from 'lucide-react'
import Sidebar from '../components/layout/Sidebar'
import Header from '../components/layout/Header'
import MessageList from '../components/chat/MessageList'
import MessageInput from '../components/chat/MessageInput'
import MessageItem from '../components/chat/MessageItem'
import MessageFeed from '../components/chat/message/MessageFeed'
import DmMessageList from '../components/dm/DmMessageList'
import DmMessageInput from '../components/dm/DmMessageInput'
import CreateServerModal from '../components/server/CreateServerModal'
import JoinServerModal from '../components/server/JoinServerModal'
import CreateChannelModal from '../components/server/CreateChannelModal'
import NewDmModal from '../components/dm/NewDmModal'
import SettingsModal from '../components/settings/SettingsModal'
import IncomingCallModal from '../components/voice/IncomingCallModal'
import CallOverlay from '../components/voice/CallOverlay'
import RoleManager from '../components/server/RoleManager'
import ServerSettingsModal from '../components/server/ServerSettingsModal'
import ChannelSettingsModal from '../components/server/ChannelSettingsModal'
import MemberListPanel from '../components/server/MemberListPanel'
import PinsPanel from '../components/chat/PinsPanel'
import VoiceChannelPanel from '../components/voice/VoiceChannelPanel'
import { useServerStore } from '../stores/serverStore'
import { useDmStore } from '../stores/dmStore'
import { useUIStore } from '../stores/uiStore'
import { useVoiceStore } from '../stores/voiceStore'
import { useAuthStore } from '../stores/authStore'
import { usePresenceStore } from '../stores/presenceStore'
import { useUnreadStore } from '../stores/unreadStore'
import { useMessageStore, type Message } from '../stores/messageStore'

const EMPTY_MESSAGES: Message[] = []
const EMPTY_TYPING_USERS: { user_id: string; username: string }[] = []

function mergeThreadReplies(primary: Message[], secondary: Message[]): Message[] {
  const merged = new Map<string, Message>()

  for (const message of primary) {
    merged.set(message.id, message)
  }

  for (const message of secondary) {
    merged.set(message.id, message)
  }

  return [...merged.values()].sort(
    (a, b) => new Date(a.inserted_at).getTime() - new Date(b.inserted_at).getTime()
  )
}

function useIsMobileLayout(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768)

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 768px)')
    const handleChange = (event: MediaQueryListEvent): void => setIsMobile(event.matches)

    setIsMobile(mediaQuery.matches)
    mediaQuery.addEventListener('change', handleChange)

    return () => {
      mediaQuery.removeEventListener('change', handleChange)
    }
  }, [])

  return isMobile
}

export default function MainPage(): React.JSX.Element {
  const isMobile = useIsMobileLayout()
  const fetchServers = useServerStore((s) => s.fetchServers)
  const activeServerId = useServerStore((s) => s.activeServerId)
  const activeChannelId = useServerStore((s) => s.activeChannelId)
  const activeChannel = useServerStore((s) => {
    const server = s.servers.find((entry) => entry.id === s.activeServerId)
    return server?.channels.find((channel) => channel.id === s.activeChannelId)
  })
  const selectedConversationId = useDmStore((s) => s.selectedConversationId)
  const showCreateServerModal = useUIStore((s) => s.showCreateServerModal)
  const showJoinServerModal = useUIStore((s) => s.showJoinServerModal)
  const showCreateChannelModal = useUIStore((s) => s.showCreateChannelModal)
  const showNewDmModal = useUIStore((s) => s.showNewDmModal)
  const showSettingsModal = useUIStore((s) => s.showSettingsModal)
  const showRoleManager = useUIStore((s) => s.showRoleManager)
  const showServerSettingsModal = useUIStore((s) => s.showServerSettingsModal)
  const showChannelSettingsModal = useUIStore((s) => s.showChannelSettingsModal)
  const showPins = useUIStore((s) => s.showPins)
  const showMemberList = useUIStore((s) => s.showMemberList)
  const showMobileNav = useUIStore((s) => s.showMobileNav)
  const openMobileNav = useUIStore((s) => s.openMobileNav)
  const closeMobileNav = useUIStore((s) => s.closeMobileNav)
  const setMemberListVisible = useUIStore((s) => s.setMemberListVisible)
  const closePins = useUIStore((s) => s.closePins)
  const incomingCall = useVoiceStore((s) => s.incomingCall)
  const voiceState = useVoiceStore((s) => s.state)
  const voiceRoomId = useVoiceStore((s) => s.roomId)
  const voiceRoomType = useVoiceStore((s) => s.roomType)
  const servers = useServerStore((s) => s.servers)
  const currentUser = useAuthStore((s) => s.user)
  const joinPresence = usePresenceStore((s) => s.joinPresence)
  const joinAllServerPresence = usePresenceStore((s) => s.joinAllServerPresence)
  const fetchUnreadCounts = useUnreadStore((s) => s.fetchUnreadCounts)
  const activeThreadParentId = useMessageStore((s) => s.activeThreadParentId)
  const activeThreadParent = useMessageStore((s) => s.activeThreadParent)
  const threadLoading = useMessageStore((s) => s.threadLoading)
  const threadError = useMessageStore((s) => s.threadError)
  const closeThread = useMessageStore((s) => s.closeThread)
  const sendThreadReply = useMessageStore((s) => s.sendThreadReply)
  const threadRepliesFromApi = useMessageStore((s) =>
    activeThreadParentId ? (s.threadRepliesByParent[activeThreadParentId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  )
  const activeTargetMessages = useMessageStore((s) => {
    if (selectedConversationId) {
      return s.messagesByChannel[selectedConversationId] ?? EMPTY_MESSAGES
    }
    if (activeChannelId) {
      return s.messagesByChannel[activeChannelId] ?? EMPTY_MESSAGES
    }
    return EMPTY_MESSAGES
  })
  const [threadReply, setThreadReply] = useState('')

  useEffect(() => {
    fetchServers()
    fetchUnreadCounts()
  }, [fetchServers, fetchUnreadCounts])

  useEffect(() => {
    if (currentUser?.id) {
      joinPresence(currentUser.id)
    }
  }, [currentUser?.id, joinPresence])

  // Join presence for ALL servers at once — presence is global, not tied to active view
  useEffect(() => {
    const serverIds = servers.map((s) => s.id)
    if (serverIds.length > 0) {
      joinAllServerPresence(serverIds)
    }
  }, [servers, joinAllServerPresence])

  const isDmView = !!selectedConversationId
  const isChannelView = !!activeChannelId && !isDmView
  const isVoiceChannelView = activeChannel?.type === 'voice'
  const isCurrentVoiceRoomView =
    isVoiceChannelView &&
    voiceRoomType === 'channel' &&
    voiceRoomId === activeChannelId
  const shouldShowCallOverlay = isMobile && voiceState !== 'idle' && !isCurrentVoiceRoomView
  const showThreadPanel = Boolean(activeThreadParentId && (isChannelView || isDmView))
  const inlineThreadReplies = activeThreadParentId
    ? activeTargetMessages.filter((message) => message.parent_message_id === activeThreadParentId)
    : EMPTY_MESSAGES
  const threadReplies = mergeThreadReplies(threadRepliesFromApi, inlineThreadReplies)
  const resolvedThreadParent = activeThreadParent ?? (
    activeThreadParentId
      ? activeTargetMessages.find((message) => message.id === activeThreadParentId) ?? null
      : null
  )
  const threadMessageLookup = resolvedThreadParent
    ? [resolvedThreadParent, ...threadReplies]
    : threadReplies

  useEffect(() => {
    if (!isMobile) {
      closeMobileNav()
      return
    }

    if (isDmView || isChannelView) {
      closeMobileNav()
    } else {
      openMobileNav()
    }
  }, [closeMobileNav, isChannelView, isDmView, isMobile, openMobileNav])

  useEffect(() => {
    if (!isMobile) {
      return
    }

    setMemberListVisible(false)
  }, [activeChannelId, isMobile, selectedConversationId, setMemberListVisible])

  useEffect(() => {
    closeThread()
  }, [activeChannelId, closeThread, selectedConversationId])

  useEffect(() => {
    setThreadReply('')
  }, [activeThreadParentId])

  const submitThreadReply = (): void => {
    const trimmed = threadReply.trim()
    if (!trimmed) {
      return
    }

    void sendThreadReply(trimmed)
    setThreadReply('')
  }

  const handleThreadSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    submitThreadReply()
  }

  const renderThreadPanel = (mobilePanel: boolean): React.JSX.Element | null => {
    if (!showThreadPanel || !activeThreadParentId) {
      return null
    }

    return (
      <section data-testid="thread-panel" className={`vesper-thread-panel${mobilePanel ? ' vesper-thread-panel-mobile' : ''}`}>
        <div className="vesper-thread-header">
          <div className="vesper-thread-header-copy">
            <h2 className="vesper-thread-title">Thread</h2>
            <p className="vesper-thread-subtitle">
              {threadReplies.length} {threadReplies.length === 1 ? 'reply' : 'replies'}
            </p>
          </div>
          <button
            type="button"
            onClick={closeThread}
            className="vesper-thread-close"
            aria-label="Close thread"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="vesper-thread-body">
          {resolvedThreadParent && (
            <div className="vesper-thread-parent">
              <MessageItem message={resolvedThreadParent} messages={threadMessageLookup} />
            </div>
          )}

          <div className="vesper-thread-divider">
            <span>Replies</span>
          </div>

          <div className="vesper-thread-feed">
            {threadError ? (
              <div className="vesper-thread-state">{threadError}</div>
            ) : (
              <MessageFeed
                messages={threadReplies}
                messageLookup={threadMessageLookup}
                typingUsers={EMPTY_TYPING_USERS}
                hasMore={false}
                emptyState={threadLoading ? 'Loading thread...' : 'No replies yet. Start the thread.'}
                onLoadMore={() => {}}
                onMarkRead={() => {}}
                isThreadView
              />
            )}
          </div>
        </div>

        <form onSubmit={handleThreadSubmit} className="vesper-thread-composer">
          <textarea
            value={threadReply}
            onChange={(event) => setThreadReply(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submitThreadReply()
              }
            }}
            placeholder="Reply to thread"
            rows={1}
            className="vesper-thread-composer-textarea"
            disabled={!resolvedThreadParent}
          />
          <button
            type="submit"
            disabled={!threadReply.trim() || !resolvedThreadParent}
            className="vesper-thread-composer-send"
          >
            <SendHorizonal className="w-4 h-4" />
          </button>
        </form>
      </section>
    )
  }

  if (isMobile) {
    return (
      <div data-testid="main-page" className="vesper-mobile-main">
        {showMobileNav ? (
          <div className="vesper-mobile-nav-shell">
            <Sidebar />
          </div>
        ) : (
          <div className="vesper-mobile-chat-shell">
            <Header mobile />

            <div className="vesper-mobile-chat-body">
              {isChannelView ? (
                <>
                  {isVoiceChannelView ? (
                    <VoiceChannelPanel />
                  ) : (
                    <>
                      <MessageList />
                      <MessageInput />
                    </>
                  )}
                </>
              ) : isDmView ? (
                <>
                  <DmMessageList />
                  <DmMessageInput />
                </>
              ) : (
                <div className="vesper-mobile-empty-state">
                  <Star className="w-10 h-10 text-text-faintest" />
                  <p>Select a channel or conversation to start chatting</p>
                </div>
              )}
            </div>

            {isChannelView && showMemberList && !showThreadPanel && <MemberListPanel />}
            {renderThreadPanel(true)}
          </div>
        )}

        {showCreateServerModal && <CreateServerModal />}
        {showJoinServerModal && <JoinServerModal />}
        {showCreateChannelModal && <CreateChannelModal />}
        {showNewDmModal && <NewDmModal />}
        {showSettingsModal && <SettingsModal />}
        {showRoleManager && <RoleManager />}
        {showServerSettingsModal && <ServerSettingsModal />}
        {showChannelSettingsModal && <ChannelSettingsModal />}
        {incomingCall && <IncomingCallModal />}
        {shouldShowCallOverlay && <CallOverlay />}
      </div>
    )
  }

  return (
    <div data-testid="main-page" className="h-screen bg-bg-primary flex overflow-hidden">
      <Sidebar />

      <div className="flex-1 flex flex-col min-w-0">
        <Header />

        <div className="flex-1 flex min-h-0">
          <div className="flex-1 flex flex-col min-w-0">
            {isChannelView ? (
              <>
                {isVoiceChannelView ? (
                  <VoiceChannelPanel />
                ) : (
                  <>
                    <MessageList />
                    <MessageInput />
                  </>
                )}
              </>
            ) : isDmView ? (
              <>
                <DmMessageList />
                <DmMessageInput />
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-text-faint gap-3">
                <Star className="w-10 h-10 text-text-faintest" />
                <p>Select a channel or conversation to start chatting</p>
              </div>
            )}
          </div>
          {renderThreadPanel(false)}
          {!showThreadPanel && isChannelView && showMemberList && <MemberListPanel />}
          {!showThreadPanel && isChannelView && showPins && activeChannelId && (
            <PinsPanel
              channelId={activeChannelId}
              topic={`chat:channel:${activeChannelId}`}
              onClose={closePins}
            />
          )}
        </div>
      </div>

      {showCreateServerModal && <CreateServerModal />}
      {showJoinServerModal && <JoinServerModal />}
      {showCreateChannelModal && <CreateChannelModal />}
      {showNewDmModal && <NewDmModal />}
      {showSettingsModal && <SettingsModal />}
      {showRoleManager && <RoleManager />}
      {showServerSettingsModal && <ServerSettingsModal />}
      {showChannelSettingsModal && <ChannelSettingsModal />}
      {incomingCall && <IncomingCallModal />}
      {shouldShowCallOverlay && <CallOverlay />}
    </div>
  )
}
