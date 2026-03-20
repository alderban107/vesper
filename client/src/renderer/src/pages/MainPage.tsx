import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { SendHorizonal, Star, X } from 'lucide-react'
import Sidebar from '../components/layout/Sidebar'
import Header from '../components/layout/Header'
import MessageList from '../components/chat/MessageList'
import MessageInput from '../components/chat/MessageInput'
import MessageItem from '../components/chat/MessageItem'
import MessageFeed from '../components/chat/message/MessageFeed'
import { useServerStore } from '../stores/serverStore'
import { useDmStore } from '../stores/dmStore'
import { useUIStore } from '../stores/uiStore'
import { useVoiceStore } from '../stores/voiceStore'
import { useAuthStore } from '../stores/authStore'
import { usePresenceStore } from '../stores/presenceStore'
import { parseMessageContent, useMessageStore, type Message } from '../stores/messageStore'
import { useSyncStore } from '../stores/syncStore'
import { getRendererClient } from '../sdk/client'

const CreateServerModal = lazy(() => import('../components/server/CreateServerModal'))
const JoinServerModal = lazy(() => import('../components/server/JoinServerModal'))
const CreateChannelModal = lazy(() => import('../components/server/CreateChannelModal'))
const NewDmModal = lazy(() => import('../components/dm/NewDmModal'))
const SettingsModal = lazy(() => import('../components/settings/SettingsModal'))
const IncomingCallModal = lazy(() => import('../components/voice/IncomingCallModal'))
const CallOverlay = lazy(() => import('../components/voice/CallOverlay'))
const RoleManager = lazy(() => import('../components/server/RoleManager'))
const ServerSettingsModal = lazy(() => import('../components/server/ServerSettingsModal'))
const ChannelSettingsModal = lazy(() => import('../components/server/ChannelSettingsModal'))
const MemberListPanel = lazy(() => import('../components/server/MemberListPanel'))
const PinsPanel = lazy(() => import('../components/chat/PinsPanel'))
const VoiceChannelPanel = lazy(() => import('../components/voice/VoiceChannelPanel'))

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

function getReplyPreview(message: Message): string {
  const parsed = parseMessageContent(message.content || '')

  if (parsed.type === 'file') {
    return parsed.text || parsed.file.name || 'Sent a file'
  }

  return parsed.text || 'View message'
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

function DeferredChrome({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return <Suspense fallback={null}>{children}</Suspense>
}

function WorkspaceStatusStrip({
  connected,
  syncing,
  lastError,
  mobile
}: {
  connected: boolean
  syncing: boolean
  lastError: string | null
  mobile?: boolean
}): React.JSX.Element | null {
  if (connected && !syncing) {
    return null
  }

  const tone = connected ? 'border-sky-400/20 bg-sky-500/10 text-sky-100' : 'border-amber-400/20 bg-amber-500/10 text-amber-100'
  const dotTone = connected ? 'bg-sky-300' : 'bg-amber-300'
  const title = connected ? 'Syncing latest activity' : 'Reconnecting to server'
  const description = connected
    ? 'Refreshing servers, DMs, unread state, and recent scope changes.'
    : lastError || 'Trying to restore the live socket so messages and presence stay current.'

  return (
    <div className={`px-3 ${mobile ? 'pt-2' : 'pt-3'}`}>
      <div className={`mx-auto flex w-full max-w-[72rem] items-start gap-3 rounded-2xl border px-4 py-3 ${tone}`}>
        <div className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${dotTone}`} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-text-primary">{title}</div>
          <div className="mt-1 text-xs leading-5 text-current">{description}</div>
        </div>
      </div>
    </div>
  )
}

export default function MainPage(): React.JSX.Element {
  const isMobile = useIsMobileLayout()
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
  const currentDevice = useAuthStore((s) => s.currentDevice)
  const canUseE2EE = useAuthStore((s) => s.canUseE2EE)
  const joinPresence = usePresenceStore((s) => s.joinPresence)
  const joinAllServerPresence = usePresenceStore((s) => s.joinAllServerPresence)
  const syncNow = useSyncStore((s) => s.syncNow)
  const syncing = useSyncStore((s) => s.syncing)
  const syncRecentScopes = useMessageStore((s) => s.syncRecentScopes)
  const activeThreadParentId = useMessageStore((s) => s.activeThreadParentId)
  const activeThreadParent = useMessageStore((s) => s.activeThreadParent)
  const threadLoading = useMessageStore((s) => s.threadLoading)
  const threadError = useMessageStore((s) => s.threadError)
  const closeThread = useMessageStore((s) => s.closeThread)
  const sendThreadReply = useMessageStore((s) => s.sendThreadReply)
  const replyingTo = useMessageStore((s) => s.replyingTo)
  const setReplyingTo = useMessageStore((s) => s.setReplyingTo)
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
  const sawInitialSocketOpenRef = useRef(false)
  const [connectionState, setConnectionState] = useState(() => {
    const clientState = getRendererClient().getState()

    return {
      connected: clientState.connected,
      lastError: null as string | null
    }
  })
  const needsEncryptedUnlock =
    currentDevice?.trust_state === 'trusted' &&
    !canUseE2EE

  useEffect(() => {
    const client = getRendererClient()
    const clientState = client.getState()
    sawInitialSocketOpenRef.current = clientState.connected
    setConnectionState({
      connected: clientState.connected,
      lastError: null
    })

    const hasHydratedWorkspace =
      useServerStore.getState().servers.length > 0 ||
      useDmStore.getState().conversations.length > 0
    void syncNow(useSyncStore.getState().token === null || !hasHydratedWorkspace)

    const unsubscribeConnected = client.on('connected', () => {
      setConnectionState({
        connected: true,
        lastError: null
      })

      if (!sawInitialSocketOpenRef.current) {
        sawInitialSocketOpenRef.current = true
        return
      }

      void (async () => {
        const previousSyncToken = useSyncStore.getState().token
        await syncNow()
        await syncRecentScopes(previousSyncToken)
      })()
    })

    const unsubscribeLost = client.on('connection.lost', () => {
      setConnectionState((current) => ({
        ...current,
        connected: false
      }))
    })

    const unsubscribeError = client.on('connection.error', (error) => {
      setConnectionState({
        connected: false,
        lastError: error.message
      })
    })

    return () => {
      unsubscribeConnected()
      unsubscribeLost()
      unsubscribeError()
    }
  }, [syncNow, syncRecentScopes])

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
  const shouldShowCallOverlay =
    voiceState !== 'idle' &&
    (voiceRoomType === 'dm' || (isMobile && !isCurrentVoiceRoomView))
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
    setReplyingTo(null)
  }, [activeThreadParentId, setReplyingTo])

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
                hasNewer={false}
                emptyState={threadLoading ? 'Loading thread...' : 'No replies yet. Start the thread.'}
                onLoadMore={() => {}}
                onLoadNewer={() => {}}
                onMarkRead={() => {}}
                isThreadView
              />
            )}
          </div>
        </div>

        <form onSubmit={handleThreadSubmit} className="vesper-thread-composer">
          {replyingTo && (
            <div className="vesper-composer-reply">
              <div className="vesper-composer-reply-copy">
                <span className="vesper-composer-reply-label">Replying to</span>
                <span className="vesper-composer-reply-author">
                  {replyingTo.sender?.display_name || replyingTo.sender?.username || 'Unknown'}
                </span>
                <span className="vesper-composer-reply-preview">
                  {getReplyPreview(replyingTo).slice(0, 96)}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setReplyingTo(null)}
                className="vesper-composer-reply-close"
                aria-label="Cancel reply"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
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
            <WorkspaceStatusStrip
              connected={connectionState.connected}
              syncing={syncing && !needsEncryptedUnlock}
              lastError={connectionState.lastError}
              mobile
            />

            <div className="vesper-mobile-chat-body">
              {isChannelView ? (
                <>
                  {isVoiceChannelView ? (
                    <DeferredChrome>
                      <VoiceChannelPanel />
                    </DeferredChrome>
                  ) : (
                    <>
                      <MessageList scope={{ kind: 'channel', id: activeChannelId! }} />
                      <MessageInput scope={{ kind: 'channel', id: activeChannelId! }} />
                    </>
                  )}
                </>
              ) : isDmView ? (
                <>
                  <MessageList scope={{ kind: 'dm', id: selectedConversationId! }} />
                  <MessageInput scope={{ kind: 'dm', id: selectedConversationId! }} />
                </>
              ) : (
                <div className="vesper-mobile-empty-state">
                  <Star className="w-10 h-10 text-text-faintest" />
                  <p>Select a channel or conversation to start chatting</p>
                </div>
              )}
            </div>

            <DeferredChrome>
              {shouldShowCallOverlay && <CallOverlay mobileDocked />}
              {isChannelView && showMemberList && !showThreadPanel && <MemberListPanel />}
            </DeferredChrome>
            {renderThreadPanel(true)}
          </div>
        )}

        <DeferredChrome>
          {showCreateServerModal && <CreateServerModal />}
          {showJoinServerModal && <JoinServerModal />}
          {showCreateChannelModal && <CreateChannelModal />}
          {showNewDmModal && <NewDmModal />}
          {showSettingsModal && <SettingsModal />}
          {showRoleManager && <RoleManager />}
          {showServerSettingsModal && <ServerSettingsModal />}
          {showChannelSettingsModal && <ChannelSettingsModal />}
          {incomingCall && <IncomingCallModal />}
        </DeferredChrome>
      </div>
    )
  }

  return (
    <div data-testid="main-page" className="h-screen bg-bg-primary flex overflow-hidden">
      <Sidebar />

      <div className="vesper-desktop-shell flex-1 flex flex-col min-w-0">
        <Header />
        <WorkspaceStatusStrip
          connected={connectionState.connected}
          syncing={syncing && !needsEncryptedUnlock}
          lastError={connectionState.lastError}
        />

        <div className="vesper-desktop-body flex-1 flex min-h-0">
          <div className="vesper-main-chat-column flex-1 flex flex-col min-w-0">
            {isChannelView ? (
              <>
                {isVoiceChannelView ? (
                  <DeferredChrome>
                    <VoiceChannelPanel />
                  </DeferredChrome>
                ) : (
                  <>
                    <MessageList scope={{ kind: 'channel', id: activeChannelId! }} />
                    <MessageInput scope={{ kind: 'channel', id: activeChannelId! }} />
                  </>
                )}
              </>
            ) : isDmView ? (
              <>
                <MessageList scope={{ kind: 'dm', id: selectedConversationId! }} />
                <MessageInput scope={{ kind: 'dm', id: selectedConversationId! }} />
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-text-faint gap-3">
                <Star className="w-10 h-10 text-text-faintest" />
                <p>Select a channel or conversation to start chatting</p>
              </div>
            )}
          </div>
          {renderThreadPanel(false)}
          <DeferredChrome>
            {!showThreadPanel && isChannelView && showMemberList && <MemberListPanel />}
            {!showThreadPanel && isChannelView && showPins && activeChannelId && (
              <PinsPanel
                channelId={activeChannelId}
                topic={`chat:channel:${activeChannelId}`}
                onClose={closePins}
              />
            )}
          </DeferredChrome>
        </div>
      </div>

      <DeferredChrome>
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
      </DeferredChrome>
    </div>
  )
}
