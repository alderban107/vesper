import { useState } from 'react'
import { Crown, MessageCircle, Copy, MoonStar, Shield, UserMinus, AtSign } from 'lucide-react'
import { useServerStore, type Member } from '../../stores/serverStore'
import { usePresenceStore, type PresenceStatus } from '../../stores/presenceStore'
import { useAuthStore } from '../../stores/authStore'
import { useDmStore } from '../../stores/dmStore'
import { useUIStore } from '../../stores/uiStore'
import Avatar from '../ui/Avatar'
import ContextMenu, { type ContextMenuItem } from '../ui/ContextMenu'
import { useContextMenu } from '../../hooks/useContextMenu'
import PanelShell from '../layout/PanelShell'
import ProfilePopout from '../profile/ProfilePopout'

const STATUS_LABELS: Record<PresenceStatus, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do Not Disturb',
  offline: 'Offline'
}

interface MemberGroup {
  id: string
  label: string
  members: Member[]
}

function sortMembers(left: Member, right: Member): number {
  const leftName = (left.user.display_name || left.user.username).toLowerCase()
  const rightName = (right.user.display_name || right.user.username).toLowerCase()
  return leftName.localeCompare(rightName)
}

function getMemberGroups(
  members: Member[],
  statuses: Record<string, PresenceStatus>,
  currentUserId?: string,
  ownerId?: string
): MemberGroup[] {
  const owners: Member[] = []
  const admins: Member[] = []
  const online: Member[] = []
  const idle: Member[] = []
  const offline: Member[] = []

  for (const member of members) {
    const status = member.user_id === currentUserId ? 'online' : (statuses[member.user_id] ?? 'offline')

    if (member.user_id === ownerId) {
      owners.push(member)
      continue
    }

    if (member.role === 'admin') {
      admins.push(member)
      continue
    }

    if (status === 'online' || status === 'dnd') {
      online.push(member)
    } else if (status === 'idle') {
      idle.push(member)
    } else {
      offline.push(member)
    }
  }

  return [
    owners.length > 0 ? { id: 'owner', label: 'Owner', members: owners.sort(sortMembers) } : null,
    admins.length > 0 ? { id: 'admins', label: 'Admins', members: admins.sort(sortMembers) } : null,
    online.length > 0 ? { id: 'online', label: 'Online', members: online.sort(sortMembers) } : null,
    idle.length > 0 ? { id: 'idle', label: 'Idle', members: idle.sort(sortMembers) } : null,
    offline.length > 0 ? { id: 'offline', label: 'Offline', members: offline.sort(sortMembers) } : null
  ].filter((group): group is MemberGroup => Boolean(group))
}

function MemberRow({
  member,
  status,
  onContextMenu,
  onOpenProfile,
  onSendMessage
}: {
  member: Member
  status: PresenceStatus
  onContextMenu: (e: React.MouseEvent, data: Member) => void
  onOpenProfile: (member: Member, anchorRect: DOMRect) => void
  onSendMessage: (member: Member) => void
}): React.JSX.Element {
  const myId = useAuthStore((s) => s.user?.id)
  const displayName = member.user?.display_name || member.user?.username || 'Unknown'
  const activeServer = useServerStore((s) => s.servers.find((srv) => srv.id === s.activeServerId))
  const isOwner = activeServer?.owner_id === member.user_id
  const isAdmin = member.role === 'admin'
  const isSelf = member.user_id === myId
  const roleLabel = isOwner ? 'Owner' : isAdmin ? 'Admin' : STATUS_LABELS[status]

  return (
    <div
      onContextMenu={(event) => onContextMenu(event, member)}
      className={`vesper-member-row ${status === 'offline' ? 'vesper-member-row-offline' : ''} ${isSelf ? 'vesper-member-row-self' : ''}`}
    >
      <button
        type="button"
        className="vesper-member-row-main"
        onClick={(event) => onOpenProfile(member, event.currentTarget.getBoundingClientRect())}
      >
        <div className="vesper-member-avatar-wrap">
          <Avatar
            userId={member.user_id}
            avatarUrl={member.user?.avatar_url}
            displayName={displayName}
            size="sm"
            status={status}
          />
        </div>

        <div className="vesper-member-copy">
          <div className="vesper-member-name-row">
            <span data-testid="member-name" className="vesper-member-name">{displayName}</span>
            {isOwner && <Crown className="vesper-member-role-icon vesper-member-role-icon-owner" />}
            {isAdmin && !isOwner && <Shield className="vesper-member-role-icon vesper-member-role-icon-admin" />}
            {status === 'idle' && !isOwner && !isAdmin && <MoonStar className="vesper-member-role-icon" />}
          </div>
          <div className="vesper-member-subcopy">
            <span>{roleLabel}</span>
            {isSelf && <span>You</span>}
          </div>
        </div>
      </button>

      {!isSelf && (
        <button
          type="button"
          className="vesper-member-message-button"
          onClick={() => onSendMessage(member)}
          title={`Message ${displayName}`}
        >
          <MessageCircle className="vesper-member-action-hint vesper-member-action-hint-visible" />
        </button>
      )}
    </div>
  )
}

export default function MemberListPanel(): React.JSX.Element {
  const members = useServerStore((s) => s.members)
  const statuses = usePresenceStore((s) => s.statuses)
  const myId = useAuthStore((s) => s.user?.id)
  const activeServer = useServerStore((s) => s.servers.find((srv) => srv.id === s.activeServerId))
  const memberListWidth = useUIStore((s) => s.memberListWidth)
  const setMemberListWidth = useUIStore((s) => s.setMemberListWidth)
  const kickMember = useServerStore((s) => s.kickMember)
  const createConversation = useDmStore((s) => s.createConversation)
  const setActiveServer = useServerStore((s) => s.setActiveServer)
  const [selectedMember, setSelectedMember] = useState<Member | null>(null)
  const [profileAnchor, setProfileAnchor] = useState<DOMRect | null>(null)

  const memberMenu = useContextMenu<Member>()
  const groups = getMemberGroups(members, statuses, myId, activeServer?.owner_id)

  const openConversation = async (member: Member): Promise<void> => {
    await createConversation([member.user_id])
    setActiveServer(null)
  }

  const getMemberItems = (member: Member): ContextMenuItem[] => {
    const isOwner = activeServer?.owner_id === myId
    const isSelf = member.user_id === myId
    const targetIsOwner = activeServer?.owner_id === member.user_id

    return [
      {
        label: 'View Profile',
        icon: MessageCircle,
        onClick: () => {
          setSelectedMember(member)
          setProfileAnchor(null)
        }
      },
      ...(!isSelf
        ? [
            {
              label: 'Send Message',
              icon: MessageCircle,
              hint: 'DM',
              onClick: async () => {
                await openConversation(member)
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
                if (activeServer) {
                  kickMember(activeServer.id, member.user_id)
                }
              },
              danger: true
            }
          ]
        : []),
      {
        label: 'Copy User ID',
        icon: Copy,
        onClick: () => navigator.clipboard.writeText(member.user_id),
        divider: true
      },
      {
        label: 'Copy Username',
        icon: AtSign,
        onClick: () => navigator.clipboard.writeText(member.user.username)
      }
    ]
  }

  return (
    <PanelShell
      side="left"
      width={memberListWidth}
      onWidthChange={setMemberListWidth}
    >
      <div data-testid="member-list" className="vesper-member-list-panel">
        <div className="vesper-member-list-header">
          <span className="vesper-member-list-title">Members</span>
          <span className="vesper-member-list-count">{members.length}</span>
        </div>

        <div className="vesper-member-list-scroller">
          {groups.map((group) => (
            <div key={group.id} className="vesper-member-group">
              <div className="vesper-member-group-header">
                <span className="vesper-member-group-name">{group.label}</span>
                <span>{group.members.length}</span>
              </div>
              {group.members.map((member) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  status={member.user_id === myId ? 'online' : (statuses[member.user_id] ?? 'offline')}
                  onContextMenu={memberMenu.onContextMenu}
                  onOpenProfile={(targetMember, anchorRect) => {
                    setSelectedMember(targetMember)
                    setProfileAnchor(anchorRect)
                  }}
                  onSendMessage={openConversation}
                />
              ))}
            </div>
          ))}
        </div>

        {selectedMember && (
          <ProfilePopout
            user={{
              id: selectedMember.user_id,
              username: selectedMember.user.username,
              displayName: selectedMember.user.display_name || selectedMember.user.username,
              avatarUrl: selectedMember.user.avatar_url,
              status: selectedMember.user_id === myId ? 'online' : (statuses[selectedMember.user_id] ?? 'offline'),
              roleLabel: activeServer?.owner_id === selectedMember.user_id ? 'Owner' : selectedMember.role,
              nickname: selectedMember.nickname
            }}
            anchorRect={profileAnchor}
            onClose={() => {
              setSelectedMember(null)
              setProfileAnchor(null)
            }}
            onMessage={selectedMember.user_id === myId ? undefined : async () => {
              await openConversation(selectedMember)
              setSelectedMember(null)
              setProfileAnchor(null)
            }}
          />
        )}

        {memberMenu.menu && (
          <ContextMenu
            x={memberMenu.menu.x}
            y={memberMenu.menu.y}
            header={{
              userId: memberMenu.menu.data.user_id,
              displayName: memberMenu.menu.data.user.display_name || memberMenu.menu.data.user.username,
              subtitle: activeServer?.owner_id === memberMenu.menu.data.user_id
                ? 'Owner'
                : memberMenu.menu.data.role === 'admin'
                  ? 'Admin'
                  : STATUS_LABELS[memberMenu.menu.data.user_id === myId ? 'online' : (statuses[memberMenu.menu.data.user_id] ?? 'offline')],
              avatarUrl: memberMenu.menu.data.user.avatar_url,
              status: memberMenu.menu.data.user_id === myId ? 'online' : (statuses[memberMenu.menu.data.user_id] ?? 'offline')
            }}
            items={getMemberItems(memberMenu.menu.data)}
            onClose={memberMenu.closeMenu}
          />
        )}
      </div>
    </PanelShell>
  )
}
