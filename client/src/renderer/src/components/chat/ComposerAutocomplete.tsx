import { useEffect, useRef } from 'react'

export interface ComposerAutocompleteItem {
  id: string
  label: string
  sublabel?: string
  value: string
  type: 'user' | 'everyone' | 'channel' | 'emoji'
  emojiGlyph?: string
}

interface Props {
  items: ComposerAutocompleteItem[]
  selectedIndex: number
  onSelect: (item: ComposerAutocompleteItem) => void
  onHover: (index: number) => void
}

export default function ComposerAutocomplete({
  items,
  selectedIndex,
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
            className={selected ? 'vesper-composer-autocomplete-item vesper-composer-autocomplete-item-selected' : 'vesper-composer-autocomplete-item'}
            onMouseEnter={() => onHover(index)}
            onMouseDown={(event) => {
              event.preventDefault()
              onSelect(item)
            }}
          >
            <div className="vesper-composer-autocomplete-icon" aria-hidden="true">
              {item.type === 'emoji'
                ? (item.emojiGlyph || ':')
                : item.type === 'channel'
                  ? '#'
                  : '@'}
            </div>
            <div className="vesper-composer-autocomplete-copy">
              <div className="vesper-composer-autocomplete-label">{item.label}</div>
              {item.sublabel && (
                <div className="vesper-composer-autocomplete-sublabel">{item.sublabel}</div>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}
