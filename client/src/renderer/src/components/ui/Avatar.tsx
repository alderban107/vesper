import { useState } from 'react'
import { getServerUrl } from '../../api/client'
import { avatarColor } from '../../utils/avatar'
import type { PresenceStatus } from '../../stores/presenceStore'

interface Props {
  userId: string
  avatarUrl?: string | null
  displayName: string
  size?: 'sm' | 'md' | 'lg'
  status?: PresenceStatus
  speaking?: boolean
}

const SIZES = {
  sm: 'vesper-avatar vesper-avatar-sm text-[10px]',
  md: 'vesper-avatar vesper-avatar-md text-xs',
  lg: 'vesper-avatar vesper-avatar-lg text-lg'
}

function resolveAvatarUrl(avatarUrl?: string | null): string | null {
  if (!avatarUrl) {
    return null
  }

  if (/^https?:\/\//.test(avatarUrl)) {
    return avatarUrl
  }

  return `${getServerUrl()}${avatarUrl.startsWith('/') ? avatarUrl : `/${avatarUrl}`}`
}

export default function Avatar({
  userId,
  avatarUrl,
  displayName,
  size = 'md',
  status,
  speaking = false
}: Props): React.JSX.Element {
  const [imgError, setImgError] = useState(false)
  const resolvedAvatarUrl = resolveAvatarUrl(avatarUrl)
  const initials = displayName.slice(0, 2).toUpperCase()
  const sizeClass = SIZES[size]
  const statusClassName = status ? `vesper-avatar-status vesper-avatar-status-${status}` : null
  const speakingClassName = speaking ? ' vesper-avatar-speaking' : ''

  return (
    <div className={`vesper-avatar-shell vesper-avatar-shell-${size}${speakingClassName}`}>
      {resolvedAvatarUrl && !imgError ? (
        <img
          src={resolvedAvatarUrl}
          alt={displayName}
          className={`${sizeClass} rounded-full object-cover`}
          onError={() => setImgError(true)}
        />
      ) : (
        <div
          className={`${sizeClass} rounded-full flex items-center justify-center text-white font-medium`}
          style={{ backgroundColor: avatarColor(userId) }}
        >
          {initials}
        </div>
      )}
      {statusClassName && <span className={statusClassName} aria-hidden="true" />}
    </div>
  )
}
