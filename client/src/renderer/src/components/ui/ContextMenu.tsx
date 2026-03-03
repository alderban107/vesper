import { useEffect, useRef } from 'react'

export interface ContextMenuItem {
  label: string
  icon?: React.ComponentType<{ className?: string }>
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  divider?: boolean
}

interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps): React.JSX.Element {
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
      {items.map((item, i) => (
        <div key={i}>
          {item.divider && <div className="border-t border-border my-1" />}
          <button
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
            {item.label}
          </button>
        </div>
      ))}
    </div>
  )
}
