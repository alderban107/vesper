import { Crown, Shield, MessageCircle, UserMinus, Copy } from 'lucide-react'
import { useServerStore, type Member } from '../../stores/serverStore'
import { usePresenceStore, type PresenceStatus } from '../../stores/presenceStore'
import { useAuthStore } from '../../stores/authStore'
import { useDmStore } from '../../stores/dmStore'
import Avatar from '../ui/Avatar'
import ContextMenu, { type ContextMenuItem } from '../ui/ContextMenu'
import { useContextMenu } from '../../hooks/useContextMenu'

const STATUS_COLORS: Record<PresenceStatus, string> = {
  online: 'bg-emerald-500',
  idle: 'bg-amber-500',
  dnd: 'bg-red-500',
  offline: 'bg-gray-500'
}

function MemberRow({
  member,
  isOnline,
  onContextMenu
}: {
  member: Member
  isOnline: boolean
  onContextMenu: (e: React.MouseEvent, data: Member) => void
}): React.JSX.Element {
  const myId = useAuthStore((s) => s.user?.id)
  const createConversation = useDmStore((s) => s.createConversation)
  const setActiveServer = useServerStore((s) => s.setActiveServer)
  const status = usePresenceStore((s) => s.statuses[member.user_id] ?? 'offline') as PresenceStatus
  const displayName = member.user?.display_name || member.user?.username || 'Unknown'
  const initials = displayName.slice(0, 2).toUpperCase()
  const activeServer = useServerStore((s) => s.servers.find((srv) => srv.id === s.activeServerId))
  const isOwner = activeServer?.owner_id === member.user_id
  const isAdmin = member.role === 'admin'

  const handleClick = async (): Promise<void> => {
    if (member.user_id === myId) return
    await createConversation([member.user_id])
    setActiveServer(null)
  }

  return (
    <button
      onClick={handleClick}
      onContextMenu={(e) => onContextMenu(e, member)}
      disabled={member.user_id === myId}
      className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg transition-colors ${
        member.user_id === myId
          ? 'cursor-default'
          : 'hover:bg-bg-secondary/50 cursor-pointer'
      } ${!isOnline ? 'opacity-50' : ''}`}
    >
      <div className="relative w-8 h-8 shrink-0">
        <Avatar
          userId={member.user_id}
          avatarUrl={member.user?.avatar_url}
          displayName={displayName}
          size="sm"
        />
        <div
          className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-bg-primary ${STATUS_COLORS[status]}`}
        />
      </div>

      <span className="text-sm text-text-secondary truncate flex-1 text-left">{displayName}</span>

      {isOwner && <Crown className="w-3.5 h-3.5 text-amber-400 shrink-0" />}
      {isAdmin && !isOwner && <Shield className="w-3.5 h-3.5 text-accent-text shrink-0" />}
    </button>
  )
}

export default function MemberListPanel(): React.JSX.Element {
  const members = useServerStore((s) => s.members)
  const statuses = usePresenceStore((s) => s.statuses)
  const myId = useAuthStore((s) => s.user?.id)
  const activeServer = useServerStore((s) => s.servers.find((srv) => srv.id === s.activeServerId))
  const kickMember = useServerStore((s) => s.kickMember)
  const createConversation = useDmStore((s) => s.createConversation)
  const setActiveServer = useServerStore((s) => s.setActiveServer)

  const memberMenu = useContextMenu<Member>()

  const online: Member[] = []
  const offline: Member[] = []

  for (const member of members) {
    // Current user is always online — it's nonsensical to show yourself as offline
    const status = member.user_id === myId ? 'online' : (statuses[member.user_id] ?? 'offline')
    if (status === 'offline') {
      offline.push(member)
    } else {
      online.push(member)
    }
  }

  const getMemberItems = (member: Member): ContextMenuItem[] => {
    const isOwner = activeServer?.owner_id === myId
    const isSelf = member.user_id === myId
    const targetIsOwner = activeServer?.owner_id === member.user_id
    return [
      ...(!isSelf
        ? [
            {
              label: 'Send Message',
              icon: MessageCircle,
              onClick: async () => {
                await createConversation([member.user_id])
                setActiveServer(null)
              }
            }
          ]
        : []),
      ...(isOwner && !targetIsOwner && !isSelf
        ? [
            {
              label: 'Kick',
              icon: UserMinus,
              onClick: () => {
                if (activeServer) kickMember(activeServer.id, member.user_id)
              },
              danger: true
            }
          ]
        : []),
      {
        label: 'Copy User ID',
        icon: Copy,
        onClick: () => navigator.clipboard.writeText(member.user_id),
        divider: (!isSelf || (isOwner && !targetIsOwner))
      }
    ]
  }

  return (
    <div className="w-56 bg-bg-primary border-l border-border flex flex-col overflow-y-auto shrink-0">
      <div className="px-3 py-3 text-xs font-semibold text-text-faint uppercase tracking-wider">
        Members — {members.length}
      </div>

      {online.length > 0 && (
        <div className="px-1.5 pb-2">
          <div className="px-2 py-1 text-[11px] font-semibold text-text-faintest uppercase tracking-wider">
            Online — {online.length}
          </div>
          {online.map((m) => (
            <MemberRow key={m.id} member={m} isOnline onContextMenu={memberMenu.onContextMenu} />
          ))}
        </div>
      )}

      {offline.length > 0 && (
        <div className="px-1.5 pb-2">
          <div className="px-2 py-1 text-[11px] font-semibold text-text-faintest uppercase tracking-wider">
            Offline — {offline.length}
          </div>
          {offline.map((m) => (
            <MemberRow key={m.id} member={m} isOnline={false} onContextMenu={memberMenu.onContextMenu} />
          ))}
        </div>
      )}

      {memberMenu.menu && (
        <ContextMenu
          x={memberMenu.menu.x}
          y={memberMenu.menu.y}
          items={getMemberItems(memberMenu.menu.data)}
          onClose={memberMenu.closeMenu}
        />
      )}
    </div>
  )
}
