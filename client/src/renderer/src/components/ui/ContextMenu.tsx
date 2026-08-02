import Avatar from './Avatar'
import FloatingSurface from './FloatingSurface'
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
  x?: number
  y?: number
  anchorRect?: DOMRect | null
  items: ContextMenuItem[]
  onClose: () => void
  header?: ContextMenuHeader
}

export default function ContextMenu({
  x,
  y,
  anchorRect,
  items,
  onClose,
  header
}: ContextMenuProps): React.JSX.Element {
  return (
    <FloatingSurface
      className="vesper-floating-surface vesper-context-menu-shell"
      point={anchorRect ? null : { x: x ?? 0, y: y ?? 0 }}
      anchorRect={anchorRect}
      placement="bottom-end"
      offset={8}
      minWidth={180}
      zIndex={90}
      onClose={onClose}
      ariaLabel="Context menu"
    >
      <div className="vesper-context-menu" role="menu">
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
              role="menuitem"
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
                    ? 'text-error hover:bg-bg-tertiary/50'
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
    </FloatingSurface>
  )
}
