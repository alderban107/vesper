import { useEffect, useRef } from 'react'
import Avatar from './Avatar'
import type { PresenceStatus } from '../../stores/presenceStore'

export interface ContextMenuItem {
  label: string
  icon?: React.ComponentType<{ className?: string }>
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  divider?: boolean
  hint?: string
  testId?: string
}

interface ContextMenuHeader {
  userId: string
  displayName: string
  subtitle?: string
  avatarUrl?: string | null
  status?: PresenceStatus
}

interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
  header?: ContextMenuHeader
}

export default function ContextMenu({ x, y, items, onClose, header }: ContextMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = menuRef.current
    if (!el) return

    // Clamp to viewport
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight

    let left = x
    let top = y

    if (left + rect.width > vw) left = vw - rect.width - 4
    if (top + rect.height > vh) top = vh - rect.height - 4
    if (left < 4) left = 4
    if (top < 4) top = 4

    el.style.left = `${left}px`
    el.style.top = `${top}px`
    el.style.visibility = 'visible'
  }, [x, y])

  useEffect(() => {
    const handleClick = (): void => onClose()
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    // Defer adding click listener so the opening right-click doesn't immediately close
    const timer = setTimeout(() => {
      document.addEventListener('click', handleClick)
      document.addEventListener('contextmenu', handleClick)
    }, 0)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('click', handleClick)
      document.removeEventListener('contextmenu', handleClick)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[180px] py-1.5 glass-card rounded-lg border border-border shadow-lg"
      style={{ left: x, top: y, visibility: 'hidden' }}
    >
      {header && (
        <>
          <div className="vesper-context-menu-header">
            <Avatar
              userId={header.userId}
              avatarUrl={header.avatarUrl}
              displayName={header.displayName}
              size="sm"
              status={header.status}
            />
            <div className="vesper-context-menu-header-copy">
              <div className="vesper-context-menu-header-title">{header.displayName}</div>
              {header.subtitle && <div className="vesper-context-menu-header-subtitle">{header.subtitle}</div>}
            </div>
          </div>
          <div className="border-t border-border my-1" />
        </>
      )}
      {items.map((item, i) => (
        <div key={i}>
          {item.divider && <div className="border-t border-border my-1" />}
          <button
            data-testid={item.testId}
            onClick={(e) => {
              e.stopPropagation()
              if (!item.disabled) {
                item.onClick()
                onClose()
              }
            }}
            disabled={item.disabled}
            className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 transition-colors ${
              item.disabled
                ? 'text-text-disabled cursor-not-allowed'
                : item.danger
                  ? 'text-red-400 hover:bg-bg-tertiary/50'
                  : 'text-text-secondary hover:bg-bg-tertiary/50 hover:text-text-primary'
            }`}
          >
            {item.icon && <item.icon className="w-4 h-4" />}
            <span className="flex-1 min-w-0">{item.label}</span>
            {item.hint && <span className="text-[11px] text-text-faint">{item.hint}</span>}
          </button>
        </div>
      ))}
    </div>
  )
}
