import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { CATEGORIES, EMOJIS, type EmojiCategory } from '../../data/emojis'
import { useServerStore } from '../../stores/serverStore'
import type { CustomEmoji } from '../../utils/emoji'

const CATEGORY_ICONS: Record<EmojiCategory, string> = {
  Smileys: '\u{1F604}',
  People: '\u{1F44B}',
  Animals: '\u{1F43A}',
  Food: '\u{1F34A}',
  Travel: '\u{1F680}',
  Activities: '\u{1F3AE}',
  Objects: '\u{1F4A1}',
  Symbols: '\u{2764}\u{FE0F}'
}

type PickerCategoryId = EmojiCategory | 'Recent' | 'Custom'

export type PickerEmoji =
  | {
      type: 'unicode'
      value: string
      name: string
      category: EmojiCategory
      keywords: string[]
    }
  | (CustomEmoji & {
      type: 'custom'
      value: string
      category: 'Custom'
      keywords: string[]
    })

interface Props {
  onSelect: (emoji: string, item?: PickerEmoji) => void
  onClose: () => void
}

function readRecentEmoji(): string[] {
  try {
    const raw = localStorage.getItem('vesper.recent-emoji')
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

function saveRecentEmoji(value: string): void {
  const next = [value, ...readRecentEmoji().filter((entry) => entry !== value)].slice(0, 24)
  localStorage.setItem('vesper.recent-emoji', JSON.stringify(next))
}

export default function EmojiPicker({ onSelect, onClose }: Props): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState<PickerCategoryId>('Recent')
  const [hoveredEmoji, setHoveredEmoji] = useState<PickerEmoji | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const activeServerId = useServerStore((s) => s.activeServerId)
  const fetchServerEmojis = useServerStore((s) => s.fetchServerEmojis)
  const activeServer = useServerStore((s) => s.servers.find((server) => server.id === s.activeServerId))
  const customEmojis = activeServer?.emojis ?? []

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  useEffect(() => {
    if (activeServerId) {
      void fetchServerEmojis(activeServerId)
    }
  }, [activeServerId, fetchServerEmojis])

  useEffect(() => {
    const handlePointerOutside = (event: PointerEvent): void => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        onClose()
      }
    }

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('pointerdown', handlePointerOutside)
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('pointerdown', handlePointerOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  const pickerSections = useMemo(() => {
    const unicodeItems: PickerEmoji[] = EMOJIS.map((emoji) => ({
      type: 'unicode',
      value: emoji.emoji,
      name: emoji.name,
      category: emoji.category as EmojiCategory,
      keywords: emoji.keywords
    }))

    const customItems: PickerEmoji[] = customEmojis.map((emoji) => ({
      ...emoji,
      type: 'custom',
      value: emoji.url,
      category: 'Custom',
      keywords: [emoji.name, emoji.server_id ?? '', emoji.animated ? 'animated' : '']
    }))

    const recentOrder = readRecentEmoji()
    const recentMap = new Map([...customItems, ...unicodeItems].map((item) => [item.type === 'custom' ? item.id : item.value, item]))
    const recentItems = recentOrder
      .map((key) => recentMap.get(key))
      .filter((item): item is PickerEmoji => Boolean(item))

    const searchValue = search.trim().toLowerCase()

    const filteredUnicode = searchValue
      ? unicodeItems.filter((item) =>
          item.name.toLowerCase().includes(searchValue) ||
          item.keywords.some((keyword) => keyword.toLowerCase().includes(searchValue))
        )
      : unicodeItems

    const filteredCustom = searchValue
      ? customItems.filter((item) =>
          item.name.toLowerCase().includes(searchValue) ||
          item.keywords.some((keyword) => keyword.toLowerCase().includes(searchValue))
        )
      : customItems

    if (searchValue) {
      const sections: Array<{ id: PickerCategoryId; label: string; items: PickerEmoji[] }> = []
      if (filteredCustom.length > 0) {
        sections.push({ id: 'Custom', label: 'Custom Emoji', items: filteredCustom })
      }
      for (const category of CATEGORIES) {
        const items = filteredUnicode.filter((item) => item.category === category)
        if (items.length > 0) {
          sections.push({ id: category, label: category, items })
        }
      }
      return sections
    }

    const sections: Array<{ id: PickerCategoryId; label: string; items: PickerEmoji[] }> = []
    if (recentItems.length > 0) {
      sections.push({ id: 'Recent', label: 'Recently Used', items: recentItems })
    }
    if (filteredCustom.length > 0) {
      sections.push({ id: 'Custom', label: 'Custom Emoji', items: filteredCustom })
    }
    for (const category of CATEGORIES) {
      sections.push({
        id: category,
        label: category,
        items: filteredUnicode.filter((item) => item.category === category)
      })
    }

    return sections.filter((section) => section.items.length > 0)
  }, [customEmojis, search])

  useEffect(() => {
    if (!pickerSections.some((section) => section.id === activeCategory)) {
      setActiveCategory(pickerSections[0]?.id ?? 'Recent')
    }
  }, [activeCategory, pickerSections])

  const categoryButtons = useMemo(() => {
    const buttons: Array<{ id: PickerCategoryId; label: string; icon: string }> = []
    if (pickerSections.some((section) => section.id === 'Recent')) {
      buttons.push({ id: 'Recent', label: 'Recently Used', icon: '\u{1F55B}' })
    }
    if (pickerSections.some((section) => section.id === 'Custom')) {
      buttons.push({ id: 'Custom', label: 'Custom Emoji', icon: '\u{2728}' })
    }
    for (const category of CATEGORIES) {
      if (pickerSections.some((section) => section.id === category)) {
        buttons.push({ id: category, label: category, icon: CATEGORY_ICONS[category] })
      }
    }
    return buttons
  }, [pickerSections])

  const handleCategoryClick = (categoryId: PickerCategoryId): void => {
    setActiveCategory(categoryId)
    const section = listRef.current?.querySelector<HTMLElement>(`[data-category-id="${categoryId}"]`)
    section?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  const handleSelect = (item: PickerEmoji): void => {
    const recentKey = item.type === 'custom' ? item.id : item.value
    saveRecentEmoji(recentKey)
    onSelect(item.type === 'custom' ? item.name : item.value, item)
    onClose()
  }

  return (
    <div ref={pickerRef} className="vesper-emoji-picker">
      <div className="vesper-emoji-picker-header">
        <div className="vesper-emoji-picker-search">
          <Search className="vesper-emoji-picker-search-icon" />
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find the perfect emoji"
            className="vesper-emoji-picker-search-input"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="vesper-emoji-picker-clear"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="vesper-emoji-picker-grid">
        <div className="vesper-emoji-picker-categories">
          {categoryButtons.map((category) => (
            <button
              key={category.id}
              type="button"
              className={category.id === activeCategory ? 'vesper-emoji-picker-category vesper-emoji-picker-category-active' : 'vesper-emoji-picker-category'}
              onClick={() => handleCategoryClick(category.id)}
              title={category.label}
            >
              <span>{category.icon}</span>
            </button>
          ))}
        </div>

        <div ref={listRef} className="vesper-emoji-picker-list">
          {pickerSections.length === 0 ? (
            <div className="vesper-emoji-picker-empty">
              <span className="vesper-emoji-picker-empty-glyph">: (</span>
              <span>No emoji found</span>
            </div>
          ) : (
            pickerSections.map((section) => (
              <section
                key={section.id}
                data-category-id={section.id}
                className="vesper-emoji-picker-section"
              >
                <div className="vesper-emoji-picker-section-header">
                  <span>{section.label}</span>
                </div>
                <div className="vesper-emoji-picker-items">
                  {section.items.map((item) => (
                    <button
                      key={item.type === 'custom' ? item.id : item.value}
                      type="button"
                      className="vesper-emoji-picker-item"
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        handleSelect(item)
                      }}
                      onMouseEnter={() => setHoveredEmoji(item)}
                      title={item.type === 'custom' ? `:${item.name}:` : item.name}
                    >
                      {item.type === 'custom' ? (
                        <img
                          src={item.url}
                          alt={`:${item.name}:`}
                          className="vesper-emoji-picker-custom-image"
                        />
                      ) : (
                        <span className="vesper-emoji-picker-glyph">{item.value}</span>
                      )}
                    </button>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </div>

      <div className="vesper-emoji-picker-inspector">
        {hoveredEmoji ? (
          <>
            <div className="vesper-emoji-picker-inspector-preview">
              {hoveredEmoji.type === 'custom' ? (
                <img
                  src={hoveredEmoji.url}
                  alt={`:${hoveredEmoji.name}:`}
                  className="vesper-emoji-picker-inspector-image"
                />
              ) : (
                <span className="vesper-emoji-picker-inspector-glyph">{hoveredEmoji.value}</span>
              )}
            </div>
            <div className="vesper-emoji-picker-inspector-copy">
              <span className="vesper-emoji-picker-inspector-name">
                {hoveredEmoji.type === 'custom' ? `:${hoveredEmoji.name}:` : hoveredEmoji.name}
              </span>
              <span className="vesper-emoji-picker-inspector-meta">
                {hoveredEmoji.type === 'custom' ? 'Custom emoji' : hoveredEmoji.category}
              </span>
            </div>
          </>
        ) : (
          <span className="vesper-emoji-picker-inspector-placeholder">Select an emoji</span>
        )}
      </div>
    </div>
  )
}
