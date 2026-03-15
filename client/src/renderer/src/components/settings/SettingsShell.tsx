import { useEffect, useMemo, useRef } from 'react'

export interface SettingsSectionItem {
  id: string
  label: string
  tone?: 'default' | 'danger'
  icon?: React.ComponentType<{ className?: string }>
}

export interface SettingsSectionGroup {
  title?: string
  items: SettingsSectionItem[]
}

interface Props {
  title: string
  activeSection: string
  sections: SettingsSectionGroup[]
  onSectionChange: (sectionId: string) => void
  onClose: () => void
  children: React.ReactNode
}

export default function SettingsShell({
  title,
  activeSection,
  sections,
  onSectionChange,
  onClose,
  children
}: Props): React.JSX.Element {
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const flatItems = useMemo(
    () => sections.flatMap((group) => group.items),
    [sections]
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  const handleNavKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, sectionId: string): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      return
    }

    event.preventDefault()

    const currentIndex = flatItems.findIndex((item) => item.id === sectionId)
    if (currentIndex === -1) {
      return
    }

    let nextIndex = currentIndex

    if (event.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % flatItems.length
    } else if (event.key === 'ArrowUp') {
      nextIndex = (currentIndex - 1 + flatItems.length) % flatItems.length
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = flatItems.length - 1
    }

    const nextItem = flatItems[nextIndex]
    onSectionChange(nextItem.id)
    itemRefs.current[nextItem.id]?.focus()
  }

  return (
    <div
      className="vesper-settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div className="vesper-settings-shell">
        <div className="vesper-settings-close-cluster">
          <button
            type="button"
            className="vesper-settings-close"
            onClick={onClose}
            aria-label="Close settings"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
            </svg>
          </button>
          <span className="vesper-settings-close-hint">ESC</span>
        </div>

        <aside className="vesper-settings-sidebar" aria-label={`${title} navigation`}>
          <div className="vesper-settings-sidebar-scroll">
            <div className="vesper-settings-nav">
              {sections.map((group, index) => (
                <section key={`${group.title ?? 'group'}-${index}`} className="vesper-settings-group">
                  {group.title && (
                    <div className="vesper-settings-group-title">
                      {group.title}
                    </div>
                  )}
                  {group.items.map((item) => {
                    const className = item.id === activeSection
                      ? `vesper-settings-nav-item vesper-settings-nav-item-active${item.tone === 'danger' ? ' vesper-settings-nav-item-danger' : ''}`
                      : `vesper-settings-nav-item${item.tone === 'danger' ? ' vesper-settings-nav-item-danger' : ''}`

                    return (
                      <button
                        key={item.id}
                        type="button"
                        ref={(node) => {
                          itemRefs.current[item.id] = node
                        }}
                        className={className}
                        onClick={() => onSectionChange(item.id)}
                        onKeyDown={(event) => handleNavKeyDown(event, item.id)}
                        aria-current={item.id === activeSection ? 'page' : undefined}
                      >
                        {item.icon && <item.icon className="vesper-settings-nav-item-icon" />}
                        {item.label}
                      </button>
                    )
                  })}
                </section>
              ))}
            </div>
          </div>
        </aside>

        <div className="vesper-settings-content-region">
          <div className="vesper-settings-content-scroll">
            <div className="vesper-settings-content-inner">
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
