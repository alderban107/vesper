import { useEffect, useState } from 'react'
import { Hash, AtSign, Phone, PhoneOff, Pin, PanelRightClose, PanelRightOpen, Menu, Settings, Users } from 'lucide-react'
import { useServerStore } from '../../stores/serverStore'
import { useDmStore } from '../../stores/dmStore'
import { useAuthStore } from '../../stores/authStore'
import { useVoiceStore } from '../../stores/voiceStore'
import { useUIStore } from '../../stores/uiStore'
import DisappearingSettings from '../chat/DisappearingSettings'
import SearchBar from '../chat/SearchBar'
import PinnedMessagesPopover from '../chat/PinnedMessagesPopover'

interface Props {
  mobile?: boolean
}

export default function Header({ mobile = false }: Props): React.JSX.Element {
  const showMemberList = useUIStore((s) => s.showMemberList)
  const toggleMemberList = useUIStore((s) => s.toggleMemberList)
  const openMobileNav = useUIStore((s) => s.openMobileNav)
  const openChannelSettingsModal = useUIStore((s) => s.openChannelSettingsModal)
  const activeServer = useServerStore((s) => s.servers.find((srv) => srv.id === s.activeServerId))
  const members = useServerStore((s) => s.members)
  const activeChannel = useServerStore((s) => {
    const server = s.servers.find((srv) => srv.id === s.activeServerId)
    return server?.channels.find((c) => c.id === s.activeChannelId)
  })
  const selectedConversationId = useDmStore((s) => s.selectedConversationId)
  const conversations = useDmStore((s) => s.conversations)
  const currentUserId = useAuthStore((s) => s.user?.id)
  const isServerOwner = activeServer?.owner_id === currentUserId
  const myMembership = members.find((member) => member.user_id === currentUserId)
  const canManagePins = Boolean(isServerOwner || myMembership?.role === 'admin')
  const voiceRoomId = useVoiceStore((s) => s.roomId)
  const voiceRoomType = useVoiceStore((s) => s.roomType)
  const disconnect = useVoiceStore((s) => s.disconnect)
  const connectionQuality = useVoiceStore((s) => s.connectionQuality)
  const [showPinnedPopover, setShowPinnedPopover] = useState(false)

  const startDmCall = useVoiceStore((s) => s.startDmCall)
  const voiceState = useVoiceStore((s) => s.state)
  const activeConversation = conversations.find((c) => c.id === selectedConversationId)

  useEffect(() => {
    setShowPinnedPopover(false)
  }, [activeChannel?.id])

  const getDmDisplayName = (): string => {
    if (!activeConversation) return 'Direct Message'
    if (activeConversation.name) return activeConversation.name
    const others = activeConversation.participants.filter((p) => p.user_id !== currentUserId)
    if (others.length === 0) return 'Saved Messages'
    return others.map((p) => p.user.display_name || p.user.username).join(', ')
  }

  if (mobile) {
    return (
      <div className="vesper-chat-header vesper-chat-header-mobile">
        {activeConversation ? (
          <>
            <button
              type="button"
              className="vesper-mobile-header-button"
              onClick={openMobileNav}
              title="Open conversations"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="vesper-mobile-header-copy">
              <div className="vesper-mobile-header-title">{getDmDisplayName()}</div>
              <div className="vesper-mobile-header-subtitle">Direct message</div>
            </div>
            <button
              data-testid="dm-call-button"
              type="button"
              onClick={() => startDmCall(activeConversation.id)}
              className="vesper-mobile-header-button"
              title={voiceState === 'idle' ? 'Start voice call' : 'Switch to this call'}
            >
              <Phone className="w-5 h-5" />
            </button>
          </>
        ) : activeChannel ? (
          <>
            <button
              type="button"
              className="vesper-mobile-header-button"
              onClick={openMobileNav}
              title="Open channels"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="vesper-mobile-header-copy">
              <div className="vesper-mobile-header-title">#{activeChannel.name}</div>
              <div className="vesper-mobile-header-subtitle">{activeServer?.name || 'Channel'}</div>
            </div>
            <button
              data-testid="toggle-members"
              type="button"
              onClick={toggleMemberList}
              className={`vesper-mobile-header-button${showMemberList ? ' vesper-mobile-header-button-active' : ''}`}
              title="Members"
            >
              <Users className="w-5 h-5" />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="vesper-mobile-header-button"
              onClick={openMobileNav}
              title="Open navigation"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="vesper-mobile-header-copy">
              <div className="vesper-mobile-header-title">{activeServer?.name || 'Messages'}</div>
            </div>
            <div className="vesper-mobile-header-spacer" />
          </>
        )}
      </div>
    )
  }

  return (
    <div className="vesper-chat-header">
      {activeConversation ? (
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <AtSign className="w-4 h-4 text-text-faint" />
          <span className="text-text-primary font-semibold">{getDmDisplayName()}</span>
          <div className="flex-1" />
          <SearchBar />
          <DisappearingSettings
            currentTtl={activeConversation.disappearing_ttl ?? null}
            topic={`dm:${activeConversation.id}`}
          />
          <button
            data-testid="dm-call-button"
            onClick={() => startDmCall(activeConversation.id)}
            className="text-text-muted hover:text-text-primary transition-colors p-1.5 rounded hover:bg-bg-tertiary/50"
            title={voiceState === 'idle' ? 'Start voice call' : 'Switch to this call'}
          >
            <Phone className="w-4 h-4" />
          </button>
        </div>
      ) : activeChannel ? (
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Hash className="w-4 h-4 text-text-faint" />
          <span className="text-text-primary font-semibold">{activeChannel.name}</span>
          {activeChannel.topic && (
            <>
              <span className="text-text-disabled mx-2">|</span>
              <span className="text-text-faint text-sm truncate">{activeChannel.topic}</span>
            </>
          )}
          <div className="flex-1" />
          <SearchBar />
          <div className="relative">
            <button
              data-testid="toggle-pins"
              onClick={() => setShowPinnedPopover((value) => !value)}
              className={`text-text-muted hover:text-text-primary transition-colors p-1.5 rounded hover:bg-bg-tertiary/50 ${showPinnedPopover ? 'text-accent' : ''}`}
              title="Pinned Messages"
            >
              <Pin className="w-4 h-4" />
            </button>
            {showPinnedPopover && activeChannel && (
              <PinnedMessagesPopover
                channelId={activeChannel.id}
                topic={`chat:channel:${activeChannel.id}`}
                canManage={canManagePins}
                onClose={() => setShowPinnedPopover(false)}
              />
            )}
          </div>
          {voiceRoomType === 'channel' && voiceRoomId === activeChannel.id && (
            <button
              onClick={disconnect}
              className="text-emerald-300 hover:text-white transition-colors px-2.5 py-1.5 rounded-full bg-emerald-500/12 hover:bg-emerald-500/18 text-xs font-semibold"
              title="Disconnect from voice"
            >
              <span className="inline-flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full animate-pulse ${
                  connectionQuality === 'good'
                    ? 'bg-emerald-400'
                    : connectionQuality === 'fair'
                      ? 'bg-amber-400'
                      : connectionQuality === 'poor'
                        ? 'bg-red-400'
                        : 'bg-text-faint'
                }`} />
                {connectionQuality === 'unknown'
                  ? 'Connected'
                  : `Connected · ${connectionQuality}`}
                <PhoneOff className="w-3.5 h-3.5" />
              </span>
            </button>
          )}
          {isServerOwner && (
            <button
              onClick={() => openChannelSettingsModal(activeChannel.id)}
              className="text-text-muted hover:text-text-primary transition-colors p-1.5 rounded hover:bg-bg-tertiary/50"
              title="Channel Settings"
            >
              <Settings className="w-4 h-4" />
            </button>
          )}
          <button
            data-testid="toggle-members"
            onClick={toggleMemberList}
            className={`text-text-muted hover:text-text-primary transition-colors p-1.5 rounded hover:bg-bg-tertiary/50 ${showMemberList ? 'text-accent' : ''}`}
            title={showMemberList ? 'Hide Member List' : 'Show Member List'}
          >
            {showMemberList ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
          </button>
          <DisappearingSettings
            currentTtl={activeChannel.disappearing_ttl ?? null}
            topic={`chat:channel:${activeChannel.id}`}
          />
        </div>
      ) : activeServer ? (
        <span className="text-text-faint">{activeServer.name}</span>
      ) : null}
    </div>
  )
}
