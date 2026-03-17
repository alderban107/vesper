import { useEffect, useRef, type RefObject } from 'react'
import { AtSign, Hash, Megaphone, Smile, Volume2 } from 'lucide-react'
import Avatar from '../ui/Avatar'
import FloatingSurface from '../ui/FloatingSurface'
import type { PresenceStatus } from '../../stores/presenceStore'

export interface ComposerAutocompleteItem {
  id: string
  label: string
  sublabel?: string
  value: string
  type: 'user' | 'everyone' | 'channel' | 'emoji'
  emojiGlyph?: string
  avatarUrl?: string | null
  avatarUserId?: string
  status?: PresenceStatus
  channelType?: string
}

interface Props {
  items: ComposerAutocompleteItem[]
  query: string
  selectedIndex: number
  anchorRef?: RefObject<HTMLElement | null>
  onSelect: (item: ComposerAutocompleteItem) => void
  onHover: (index: number) => void
}

function renderMatch(text: string, query: string): React.JSX.Element {
  if (!query.trim()) {
    return <>{text}</>
  }

  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const start = lowerText.indexOf(lowerQuery)
  if (start === -1) {
    return <>{text}</>
  }

  const end = start + lowerQuery.length
  return (
    <>
      {text.slice(0, start)}
      <span className="vesper-composer-autocomplete-match">{text.slice(start, end)}</span>
      {text.slice(end)}
    </>
  )
}

function ItemIcon({ item }: { item: ComposerAutocompleteItem }): React.JSX.Element {
  if (item.type === 'user' || item.type === 'everyone') {
    if (item.avatarUrl || item.avatarUserId) {
      return (
        <Avatar
          userId={item.avatarUserId ?? item.id}
          avatarUrl={item.avatarUrl}
          displayName={item.label}
          size="sm"
          status={item.status}
        />
      )
    }

    return (
      <span className="vesper-composer-autocomplete-icon-glyph">
        <AtSign className="w-4 h-4" />
      </span>
    )
  }

  if (item.type === 'channel') {
    if (item.channelType === 'announcement') {
      return (
        <span className="vesper-composer-autocomplete-icon-glyph">
          <Megaphone className="w-4 h-4" />
        </span>
      )
    }

    if (item.channelType === 'voice') {
      return (
        <span className="vesper-composer-autocomplete-icon-glyph">
          <Volume2 className="w-4 h-4" />
        </span>
      )
    }

    return (
      <span className="vesper-composer-autocomplete-icon-glyph">
        <Hash className="w-4 h-4" />
      </span>
    )
  }

  return (
    <span className="vesper-composer-autocomplete-emoji-glyph" aria-hidden="true">
      {item.emojiGlyph || <Smile className="w-4 h-4" />}
    </span>
  )
}

export default function ComposerAutocomplete({
  items,
  query,
  selectedIndex,
  anchorRef,
  onSelect,
  onHover
}: Props): React.JSX.Element | null {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!listRef.current) {
      return
    }

    const selected = listRef.current.children[selectedIndex] as HTMLElement | undefined
    selected?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (items.length === 0) {
    return null
  }

  return (
    <FloatingSurface
      anchorRef={anchorRef}
      placement="top-start"
      offset={10}
      minWidth="anchor"
      maxWidth={420}
      zIndex={84}
      className="vesper-composer-autocomplete-shell"
      closeOnEscape={false}
      closeOnPointerDownOutside={false}
    >
      <div
        ref={listRef}
        data-testid="composer-autocomplete"
        data-autocomplete="true"
        className="vesper-composer-autocomplete"
        role="listbox"
        aria-label="Composer suggestions"
      >
        {items.map((item, index) => {
          const selected = index === selectedIndex

          return (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={selected}
              className={
                selected
                  ? 'vesper-composer-autocomplete-item vesper-composer-autocomplete-item-selected'
                  : 'vesper-composer-autocomplete-item'
              }
              onMouseEnter={() => onHover(index)}
              onMouseDown={(event) => {
                event.preventDefault()
                onSelect(item)
              }}
            >
              <div className="vesper-composer-autocomplete-icon" aria-hidden="true">
                <ItemIcon item={item} />
              </div>
              <div className="vesper-composer-autocomplete-copy">
                <div className="vesper-composer-autocomplete-label">
                  {renderMatch(item.label, query)}
                </div>
                {item.sublabel && (
                  <div className="vesper-composer-autocomplete-sublabel">{item.sublabel}</div>
                )}
              </div>
            </button>
          )
        })}
      </div>
    </FloatingSurface>
  )
}
