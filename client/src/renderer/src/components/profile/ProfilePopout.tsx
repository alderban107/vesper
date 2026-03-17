import { useState } from 'react'
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

type ProfileTab = 'about' | 'details'

export default function ProfilePopout({
  user,
  anchorRect,
  placement = 'side',
  onClose,
  onMessage,
  onOpenSettings
}: Props): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<ProfileTab>('about')
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
          <div className="vesper-profile-popout-avatar-ring">
            <Avatar
              userId={user.id}
              avatarUrl={user.avatarUrl}
              displayName={user.displayName}
              size="lg"
              status={user.status}
            />
          </div>
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

          <div className="vesper-profile-popout-tabs" role="tablist" aria-label="Profile sections">
            <button
              type="button"
              className={activeTab === 'about' ? 'vesper-profile-popout-tab vesper-profile-popout-tab-active' : 'vesper-profile-popout-tab'}
              onClick={() => setActiveTab('about')}
              role="tab"
              aria-selected={activeTab === 'about'}
            >
              About Me
            </button>
            <button
              type="button"
              className={activeTab === 'details' ? 'vesper-profile-popout-tab vesper-profile-popout-tab-active' : 'vesper-profile-popout-tab'}
              onClick={() => setActiveTab('details')}
              role="tab"
              aria-selected={activeTab === 'details'}
            >
              Details
            </button>
          </div>

          {activeTab === 'about' ? (
            <>
              <section className="vesper-profile-popout-section">
                <div className="vesper-profile-popout-section-title">About</div>
                <div className="vesper-profile-popout-section-copy">
                  {user.isCurrentUser
                    ? 'This is your current Vesper profile. Open settings to update your display name, avatar, and client preferences.'
                    : `${user.displayName} is hanging out in this server. You can start a direct conversation from here.`}
                </div>
              </section>

              <section className="vesper-profile-popout-section">
                <div className="vesper-profile-popout-section-title">Quick Facts</div>
                <div className="vesper-profile-popout-facts">
                  <div className="vesper-profile-popout-fact">
                    <span className="vesper-profile-popout-fact-label">Status</span>
                    <span className="vesper-profile-popout-fact-value">{STATUS_COPY[user.status]}</span>
                  </div>
                  <div className="vesper-profile-popout-fact">
                    <span className="vesper-profile-popout-fact-label">Handle</span>
                    <span className="vesper-profile-popout-fact-value">@{user.username}</span>
                  </div>
                </div>
              </section>
            </>
          ) : (
            <>
              {user.nickname && user.nickname !== user.displayName && (
                <section className="vesper-profile-popout-section">
                  <div className="vesper-profile-popout-section-title">Server Nickname</div>
                  <div className="vesper-profile-popout-section-copy">{user.nickname}</div>
                </section>
              )}

              <section className="vesper-profile-popout-section">
                <div className="vesper-profile-popout-section-title">Profile Details</div>
                <div className="vesper-profile-popout-facts">
                  <div className="vesper-profile-popout-fact">
                    <span className="vesper-profile-popout-fact-label">Display Name</span>
                    <span className="vesper-profile-popout-fact-value">{user.displayName}</span>
                  </div>
                  <div className="vesper-profile-popout-fact">
                    <span className="vesper-profile-popout-fact-label">Presence</span>
                    <span className="vesper-profile-popout-fact-value">{STATUS_COPY[user.status]}</span>
                  </div>
                  {user.roleLabel && (
                    <div className="vesper-profile-popout-fact">
                      <span className="vesper-profile-popout-fact-label">Role</span>
                      <span className="vesper-profile-popout-fact-value">{user.roleLabel}</span>
                    </div>
                  )}
                </div>
              </section>
            </>
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
