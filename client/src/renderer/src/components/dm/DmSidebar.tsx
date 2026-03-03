import { useEffect } from 'react'
import { Plus } from 'lucide-react'
import { useDmStore, type DmConversation } from '../../stores/dmStore'
import { useAuthStore } from '../../stores/authStore'
import { useUIStore } from '../../stores/uiStore'
import { useUnreadStore } from '../../stores/unreadStore'
import Avatar from '../ui/Avatar'

export default function DmSidebar(): React.JSX.Element {
  const conversations = useDmStore((s) => s.conversations)
  const selectedId = useDmStore((s) => s.selectedConversationId)
  const selectConversation = useDmStore((s) => s.selectConversation)
  const fetchConversations = useDmStore((s) => s.fetchConversations)
  const openNewDmModal = useUIStore((s) => s.openNewDmModal)
  const currentUserId = useAuthStore((s) => s.user?.id)
  const dmUnreads = useUnreadStore((s) => s.dmUnreads)

  useEffect(() => {
    fetchConversations()
  }, [fetchConversations])

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
            return (
              <button
                key={conv.id}
                onClick={() => selectConversation(conv.id)}
                className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors ${
                  conv.id === selectedId
                    ? 'bg-bg-tertiary/80 text-text-primary'
                    : 'text-text-muted hover:text-text-primary hover:bg-bg-tertiary/30'
                }`}
              >
                <div className="shrink-0">
                  <Avatar
                    userId={(() => {
                      const others = conv.participants.filter((p) => p.user_id !== currentUserId)
                      return others[0]?.user_id || conv.id
                    })()}
                    avatarUrl={(() => {
                      const others = conv.participants.filter((p) => p.user_id !== currentUserId)
                      return others[0]?.user?.avatar_url
                    })()}
                    displayName={getDisplayName(conv)}
                    size="sm"
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
                  <span className="min-w-[18px] h-[18px] bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1 shrink-0">
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
