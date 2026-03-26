import { MessageCircle, Settings2, Shield, X } from 'lucide-react'
import Avatar from '../ui/Avatar'
import FloatingSurface from '../ui/FloatingSurface'
import type { PresenceStatus } from '../../stores/presenceStore'
import { useAuthStore } from '../../stores/authStore'

interface ProfileUser {
  id: string
  username: string
  displayName: string
  avatarUrl?: string | null
  bannerUrl?: string | null
  status: PresenceStatus
  roleLabel?: string
  nickname?: string | null
  isCurrentUser?: boolean
}

interface Props {
  user: ProfileUser
  anchorRect?: DOMRect | null
  placement?: 'side' | 'top-right'
  onClose: () => void
  onMessage?: () => void
  onOpenSettings?: () => void
}

const STATUS_COPY: Record<PresenceStatus, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do Not Disturb',
  offline: 'Offline'
}

export default function ProfilePopout({
  user,
  anchorRect,
  placement = 'side',
  onClose,
  onMessage,
  onOpenSettings
}: Props): React.JSX.Element {
  const myBannerUrl = useAuthStore((s) => s.user?.banner_url ?? null)
  const resolvedBannerUrl = user.bannerUrl ?? (user.isCurrentUser ? myBannerUrl : null)
  const bannerStyle = resolvedBannerUrl ? { backgroundImage: `url("${resolvedBannerUrl}")` } : undefined

  return (
    <FloatingSurface
      anchorRect={anchorRect}
      placement={placement === 'top-right' ? 'top-end' : 'right-start'}
      offset={placement === 'top-right' ? 12 : 16}
      minWidth={320}
      maxWidth={368}
      className="vesper-profile-popout-layer"
      onClose={onClose}
      ariaLabel={`${user.displayName} profile`}
    >
      <div className="vesper-profile-popout">
        <div
          className={`vesper-profile-popout-banner${resolvedBannerUrl ? ' vesper-profile-popout-banner-image' : ''}`}
          style={bannerStyle}
        />
        <div className="vesper-profile-popout-topbar">
          <button
            type="button"
            className="vesper-profile-popout-close"
            onClick={onClose}
            aria-label="Close profile card"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="vesper-profile-popout-avatar-wrap">
          <Avatar
            userId={user.id}
            avatarUrl={user.avatarUrl}
            displayName={user.displayName}
            size="xl"
            status={user.status}
          />
        </div>

        <div className="vesper-profile-popout-body">
          <div className="vesper-profile-popout-name">
            {user.displayName}
          </div>
          <div className="vesper-profile-popout-handle">
            @{user.username}
          </div>

          <div className="vesper-profile-popout-meta-row">
            <span className={`vesper-profile-status-dot vesper-profile-status-${user.status}`} />
            <span>{STATUS_COPY[user.status]}</span>
            {user.roleLabel && (
              <>
                <span className="vesper-profile-popout-separator" />
                <Shield className="w-3.5 h-3.5" />
                <span>{user.roleLabel}</span>
              </>
            )}
          </div>

          {user.nickname && user.nickname !== user.displayName && (
            <section className="vesper-profile-popout-section">
              <div className="vesper-profile-popout-section-title">Server Nickname</div>
              <div className="vesper-profile-popout-section-copy">{user.nickname}</div>
            </section>
          )}

          {user.roleLabel && (
            <section className="vesper-profile-popout-section">
              <div className="vesper-profile-popout-section-title">Role</div>
              <div className="vesper-profile-popout-section-copy">{user.roleLabel}</div>
            </section>
          )}

          <div className="vesper-profile-popout-actions">
            {user.isCurrentUser ? (
              <button
                type="button"
                className="vesper-profile-popout-primary"
                onClick={onOpenSettings}
              >
                <Settings2 className="w-4 h-4" />
                Edit Profile
              </button>
            ) : (
              <button
                type="button"
                className="vesper-profile-popout-primary"
                onClick={onMessage}
              >
                <MessageCircle className="w-4 h-4" />
                Message
              </button>
            )}
          </div>
        </div>
      </div>
    </FloatingSurface>
  )
}
