import { useEffect, useMemo, useState } from 'react'
import { useAuthStore } from '../../../stores/authStore'

interface TypingUser {
  user_id: string
  username: string
}

interface Props {
  typingUsers: TypingUser[]
}

interface TypingSummary {
  count: number
  users: TypingUser[]
  variant: 'none' | 'single' | 'pair' | 'many'
}

function getUniqueTypingUsers(users: TypingUser[], currentUserId: string | null): TypingUser[] {
  return users
    .filter((user) => user.user_id && user.user_id !== currentUserId)
    .filter((user, index, allUsers) => allUsers.findIndex((candidate) => candidate.user_id === user.user_id) === index)
}

function buildTypingSummary(users: TypingUser[], currentUserId: string | null): TypingSummary {
  const uniqueUsers = getUniqueTypingUsers(users, currentUserId)

  if (uniqueUsers.length === 0) {
    return {
      count: 0,
      users: [],
      variant: 'none'
    }
  }

  if (uniqueUsers.length === 1) {
    return {
      count: 1,
      users: uniqueUsers,
      variant: 'single'
    }
  }

  if (uniqueUsers.length === 2) {
    return {
      count: 2,
      users: uniqueUsers,
      variant: 'pair'
    }
  }

  return {
    count: uniqueUsers.length,
    users: uniqueUsers,
    variant: 'many'
  }
}

function buildTypingText(summary: TypingSummary): React.ReactNode {
  if (summary.variant === 'none') {
    return null
  }

  if (summary.variant === 'single') {
    return (
      <>
        <strong className="vesper-typing-indicator-username">{summary.users[0].username || 'Someone'}</strong>
        <span> is typing...</span>
      </>
    )
  }

  if (summary.variant === 'pair') {
    return (
      <>
        <strong className="vesper-typing-indicator-username">{summary.users[0].username || 'Someone'}</strong>
        <span> and </span>
        <strong className="vesper-typing-indicator-username">{summary.users[1].username || 'someone'}</strong>
        <span> are typing...</span>
      </>
    )
  }

  return <span>Several people are typing...</span>
}

export default function TypingIndicator({ typingUsers }: Props): React.JSX.Element {
  const currentUserId = useAuthStore((s) => s.user?.id ?? null)
  const summary = useMemo(() => buildTypingSummary(typingUsers, currentUserId), [currentUserId, typingUsers])
  const isVisible = summary.count > 0
  const [isWindowFocused, setIsWindowFocused] = useState(typeof document !== 'undefined' ? document.hasFocus() : true)
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false
  )

  useEffect(() => {
    const handleFocus = (): void => setIsWindowFocused(true)
    const handleBlur = (): void => setIsWindowFocused(false)
    const handleVisibilityChange = (): void => {
      setIsWindowFocused(document.visibilityState === 'visible' && document.hasFocus())
    }

    window.addEventListener('focus', handleFocus)
    window.addEventListener('blur', handleBlur)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('blur', handleBlur)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }

    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handleChange = (event: MediaQueryListEvent): void => setPrefersReducedMotion(event.matches)

    setPrefersReducedMotion(mediaQuery.matches)
    mediaQuery.addEventListener('change', handleChange)

    return () => {
      mediaQuery.removeEventListener('change', handleChange)
    }
  }, [])

  return (
    <div
      className={`vesper-typing-indicator${isVisible ? '' : ' vesper-typing-indicator-hidden'}`}
      aria-live={isVisible ? 'polite' : 'off'}
      aria-atomic="true"
      role={isVisible ? 'status' : undefined}
    >
      {isVisible && (
        <div className="vesper-typing-indicator-inner">
          <div
            className={`vesper-typing-indicator-dots${isWindowFocused ? ' vesper-typing-indicator-dots-focused' : ''}${prefersReducedMotion ? ' vesper-typing-indicator-dots-reduced' : ''}`}
            aria-hidden="true"
          >
            <span className="vesper-typing-indicator-dot" />
            <span className="vesper-typing-indicator-dot" />
            <span className="vesper-typing-indicator-dot" />
          </div>
          <span className="vesper-typing-indicator-text">{buildTypingText(summary)}</span>
        </div>
      )}
    </div>
  )
}
