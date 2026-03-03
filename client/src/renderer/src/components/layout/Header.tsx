import { Hash, AtSign, Phone, Pin } from 'lucide-react'
import { useServerStore } from '../../stores/serverStore'
import { useDmStore } from '../../stores/dmStore'
import { useAuthStore } from '../../stores/authStore'
import { useVoiceStore } from '../../stores/voiceStore'
import { useUIStore } from '../../stores/uiStore'
import DisappearingSettings from '../chat/DisappearingSettings'
import SearchBar from '../chat/SearchBar'

export default function Header(): React.JSX.Element {
  const showPins = useUIStore((s) => s.showPins)
  const togglePins = useUIStore((s) => s.togglePins)
  const activeServer = useServerStore((s) => s.servers.find((srv) => srv.id === s.activeServerId))
  const activeChannel = useServerStore((s) => {
    const server = s.servers.find((srv) => srv.id === s.activeServerId)
    return server?.channels.find((c) => c.id === s.activeChannelId)
  })
  const selectedConversationId = useDmStore((s) => s.selectedConversationId)
  const conversations = useDmStore((s) => s.conversations)
  const currentUserId = useAuthStore((s) => s.user?.id)

  const startDmCall = useVoiceStore((s) => s.startDmCall)
  const voiceState = useVoiceStore((s) => s.state)
  const activeConversation = conversations.find((c) => c.id === selectedConversationId)

  const getDmDisplayName = (): string => {
    if (!activeConversation) return 'Direct Message'
    if (activeConversation.name) return activeConversation.name
    const others = activeConversation.participants.filter((p) => p.user_id !== currentUserId)
    if (others.length === 0) return 'Saved Messages'
    return others.map((p) => p.user.display_name || p.user.username).join(', ')
  }

  return (
    <div className="h-12 bg-bg-secondary/80 backdrop-blur-sm border-b border-border flex items-center px-4 shrink-0">
      {activeConversation ? (
        <div className="flex items-center gap-2 flex-1">
          <AtSign className="w-4 h-4 text-text-faint" />
          <span className="text-text-primary font-semibold">{getDmDisplayName()}</span>
          <div className="flex-1" />
          <SearchBar />
          <DisappearingSettings
            currentTtl={activeConversation.disappearing_ttl ?? null}
            topic={`dm:${activeConversation.id}`}
          />
          <button
            onClick={() => startDmCall(activeConversation.id)}
            disabled={voiceState !== 'idle'}
            className="text-text-muted hover:text-text-primary disabled:text-text-disabled transition-colors p-1.5 rounded hover:bg-bg-tertiary/50"
            title="Start voice call"
          >
            <Phone className="w-4 h-4" />
          </button>
        </div>
      ) : activeChannel ? (
        <div className="flex items-center gap-2 flex-1">
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
          <button
            onClick={togglePins}
            className={`text-text-muted hover:text-text-primary transition-colors p-1.5 rounded hover:bg-bg-tertiary/50 ${showPins ? 'text-accent' : ''}`}
            title="Pinned Messages"
          >
            <Pin className="w-4 h-4" />
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
