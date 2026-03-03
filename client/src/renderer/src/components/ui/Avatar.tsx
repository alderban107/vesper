import { useState } from 'react'
import { avatarColor } from '../../utils/avatar'

interface Props {
  userId: string
  avatarUrl?: string | null
  displayName: string
  size?: 'sm' | 'md' | 'lg'
}

const SIZES = {
  sm: 'w-8 h-8 text-[10px]',
  md: 'w-10 h-10 text-xs',
  lg: 'w-16 h-16 text-lg'
}

export default function Avatar({ userId, avatarUrl, displayName, size = 'md' }: Props): React.JSX.Element {
  const [imgError, setImgError] = useState(false)
  const initials = displayName.slice(0, 2).toUpperCase()
  const sizeClass = SIZES[size]

  if (avatarUrl && !imgError) {
    return (
      <img
        src={avatarUrl}
        alt={displayName}
        className={`${sizeClass} rounded-full object-cover`}
        onError={() => setImgError(true)}
      />
    )
  }

  return (
    <div
      className={`${sizeClass} rounded-full flex items-center justify-center text-white font-medium`}
      style={{ backgroundColor: avatarColor(userId) }}
    >
      {initials}
    </div>
  )
}
