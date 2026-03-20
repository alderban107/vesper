import { Plus } from 'lucide-react'
import { useDmStore, type DmConversation } from '../../stores/dmStore'
import { useAuthStore } from '../../stores/authStore'
import { useMessageStore } from '../../stores/messageStore'
import { useUIStore } from '../../stores/uiStore'
import { useUnreadStore } from '../../stores/unreadStore'
import { usePresenceStore } from '../../stores/presenceStore'
import Avatar from '../ui/Avatar'

export default function DmSidebar(): React.JSX.Element {
  const conversations = useDmStore((s) => s.conversations)
  const selectedId = useDmStore((s) => s.selectedConversationId)
  const selectConversation = useDmStore((s) => s.selectConversation)
  const joinDmChat = useMessageStore((s) => s.joinDmChat)
  const fetchDmMessages = useMessageStore((s) => s.fetchDmMessages)
  const openNewDmModal = useUIStore((s) => s.openNewDmModal)
  const closeMobileNav = useUIStore((s) => s.closeMobileNav)
  const currentUserId = useAuthStore((s) => s.user?.id)
  const dmUnreads = useUnreadStore((s) => s.dmUnreads)
  const getPresenceStatus = usePresenceStore((s) => s.getStatus)
  const isMobileLayout = typeof window !== 'undefined' && window.innerWidth <= 768

  const getDisplayName = (conv: DmConversation): string => {
    if (conv.name) return conv.name
    const others = conv.participants.filter((p) => p.user_id !== currentUserId)
    if (others.length === 0) return 'Saved Messages'
    return others.map((p) => p.user.display_name || p.user.username).join(', ')
  }

  const getPreview = (conv: DmConversation): string => {
    if (!conv.last_message) return 'No messages yet'
    if (conv.last_message.ciphertext) return 'Message'
    return conv.last_message.content || ''
  }

  const handleConversationSelect = (conversationId: string): void => {
    const isReselectingCurrent = conversationId === selectedId
    selectConversation(conversationId)

    if (isReselectingCurrent) {
      joinDmChat(conversationId)
      void fetchDmMessages(conversationId)
    }

    if (isMobileLayout) {
      closeMobileNav()
    }
  }

  return (
    <>
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <h2 className="text-text-primary font-semibold">Direct Messages</h2>
        <button
          onClick={openNewDmModal}
          className="text-text-faint hover:text-text-secondary transition-colors p-1 rounded hover:bg-bg-tertiary/50"
          title="New Message"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {conversations.length === 0 ? (
          <div className="px-4 py-8 text-text-faintest text-sm text-center">
            No conversations yet
          </div>
        ) : (
          conversations.map((conv) => {
            const unread = dmUnreads[conv.id] || 0
            const otherParticipant = conv.participants.find((p) => p.user_id !== currentUserId)
            const liveStatus = otherParticipant ? getPresenceStatus(otherParticipant.user_id) : undefined
            return (
              <button
                data-testid="dm-row"
                key={conv.id}
                onClick={() => handleConversationSelect(conv.id)}
                className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors ${
                  conv.id === selectedId
                    ? 'bg-bg-tertiary/80 text-text-primary'
                    : 'text-text-muted hover:text-text-primary hover:bg-bg-tertiary/30'
                }`}
              >
                <div className="shrink-0">
                  <Avatar
                    userId={otherParticipant?.user_id || conv.id}
                    avatarUrl={otherParticipant?.user?.avatar_url}
                    displayName={getDisplayName(conv)}
                    size="sm"
                    status={liveStatus}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <p className={`text-sm truncate ${
                    unread > 0 && conv.id !== selectedId
                      ? 'font-semibold text-text-primary'
                      : 'font-medium'
                  }`}>
                    {getDisplayName(conv)}
                  </p>
                  <p className="text-xs text-text-faint truncate">{getPreview(conv)}</p>
                </div>
                {unread > 0 && conv.id !== selectedId && (
                  <span className="vesper-dm-unread-badge min-w-[18px] h-[18px] bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1 shrink-0">
                    {unread > 99 ? '99+' : unread}
                  </span>
                )}
              </button>
            )
          })
        )}
      </div>
    </>
  )
}
