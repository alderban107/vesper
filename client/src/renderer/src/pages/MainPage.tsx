import { useEffect } from 'react'
import { Star } from 'lucide-react'
import Sidebar from '../components/layout/Sidebar'
import Header from '../components/layout/Header'
import MessageList from '../components/chat/MessageList'
import MessageInput from '../components/chat/MessageInput'
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
import MemberListPanel from '../components/server/MemberListPanel'
import PinsPanel from '../components/chat/PinsPanel'
import { useServerStore } from '../stores/serverStore'
import { useDmStore } from '../stores/dmStore'
import { useUIStore } from '../stores/uiStore'
import { useVoiceStore } from '../stores/voiceStore'
import { useAuthStore } from '../stores/authStore'
import { usePresenceStore } from '../stores/presenceStore'
import { useUnreadStore } from '../stores/unreadStore'

export default function MainPage(): React.JSX.Element {
  const fetchServers = useServerStore((s) => s.fetchServers)
  const activeServerId = useServerStore((s) => s.activeServerId)
  const activeChannelId = useServerStore((s) => s.activeChannelId)
  const selectedConversationId = useDmStore((s) => s.selectedConversationId)
  const showCreateServerModal = useUIStore((s) => s.showCreateServerModal)
  const showJoinServerModal = useUIStore((s) => s.showJoinServerModal)
  const showCreateChannelModal = useUIStore((s) => s.showCreateChannelModal)
  const showNewDmModal = useUIStore((s) => s.showNewDmModal)
  const showSettingsModal = useUIStore((s) => s.showSettingsModal)
  const showRoleManager = useUIStore((s) => s.showRoleManager)
  const showServerSettingsModal = useUIStore((s) => s.showServerSettingsModal)
  const showPins = useUIStore((s) => s.showPins)
  const showMemberList = useUIStore((s) => s.showMemberList)
  const closePins = useUIStore((s) => s.closePins)
  const incomingCall = useVoiceStore((s) => s.incomingCall)
  const servers = useServerStore((s) => s.servers)
  const currentUser = useAuthStore((s) => s.user)
  const joinPresence = usePresenceStore((s) => s.joinPresence)
  const joinAllServerPresence = usePresenceStore((s) => s.joinAllServerPresence)
  const fetchUnreadCounts = useUnreadStore((s) => s.fetchUnreadCounts)

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

  return (
    <div data-testid="main-page" className="h-screen bg-bg-primary flex overflow-hidden">
      <Sidebar />

      <div className="flex-1 flex flex-col min-w-0">
        <Header />

        <div className="flex-1 flex min-h-0">
          <div className="flex-1 flex flex-col min-w-0">
            {isChannelView ? (
              <>
                <MessageList />
                <MessageInput />
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
          {isChannelView && showMemberList && <MemberListPanel />}
          {isChannelView && showPins && activeChannelId && (
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
      {incomingCall && <IncomingCallModal />}
      <CallOverlay />
    </div>
  )
}
