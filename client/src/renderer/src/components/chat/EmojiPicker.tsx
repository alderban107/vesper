import { useState, useRef, useEffect, useMemo } from 'react'
import { Search, X } from 'lucide-react'
import { EMOJIS, CATEGORIES, type EmojiCategory } from '../../data/emojis'

const CATEGORY_ICONS: Record<EmojiCategory, string> = {
  Smileys: '\u{1F600}',
  People: '\u{1F44B}',
  Animals: '\u{1F43E}',
  Food: '\u{1F354}',
  Travel: '\u{1F30D}',
  Activities: '\u{26BD}',
  Objects: '\u{1F4BB}',
  Symbols: '\u{2764}\u{FE0F}'
}

interface Props {
  onSelect: (emoji: string) => void
  onClose: () => void
}

export default function EmojiPicker({ onSelect, onClose }: Props): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState<EmojiCategory>('Smileys')
  const searchRef = useRef<HTMLInputElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  const filtered = useMemo(() => {
    if (!search.trim()) return null
    const q = search.toLowerCase()
    return EMOJIS.filter(
      (e) =>
        e.name.includes(q) ||
        e.keywords.some((k) => k.includes(q))
    )
  }, [search])

  const categoryEmojis = useMemo(() => {
    if (filtered) return null
    return EMOJIS.filter((e) => e.category === activeCategory)
  }, [activeCategory, filtered])

  const displayEmojis = filtered ?? categoryEmojis ?? []

  return (
    <div
      ref={pickerRef}
      className="glass-card rounded-xl w-80 h-[400px] flex flex-col animate-scale-in overflow-hidden"
    >
      {/* Search */}
      <div className="px-3 pt-3 pb-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-faintest" />
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search emoji..."
            className="w-full bg-bg-base/50 text-text-primary pl-8 pr-8 py-1.5 rounded-lg border border-border text-xs focus:outline-none focus:border-accent/50"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-faintest hover:text-text-primary"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Category tabs */}
      {!filtered && (
        <div className="flex items-center gap-0.5 px-2 pb-1.5">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => {
                setActiveCategory(cat)
                if (gridRef.current) gridRef.current.scrollTop = 0
              }}
              className={`flex-1 flex items-center justify-center py-1 rounded-md text-sm transition-colors ${
                activeCategory === cat
                  ? 'bg-bg-tertiary'
                  : 'hover:bg-bg-tertiary/50'
              }`}
              title={cat}
            >
              {CATEGORY_ICONS[cat]}
            </button>
          ))}
        </div>
      )}

      {/* Category label */}
      <div className="px-3 py-1">
        <span className="text-text-faintest text-[10px] font-medium uppercase tracking-wider">
          {filtered ? `Results (${filtered.length})` : activeCategory}
        </span>
      </div>

      {/* Emoji grid */}
      <div ref={gridRef} className="flex-1 overflow-y-auto px-2 pb-2">
        {displayEmojis.length === 0 ? (
          <div className="flex items-center justify-center h-full text-text-faintest text-xs">
            No emoji found
          </div>
        ) : (
          <div className="grid grid-cols-8 gap-0.5">
            {displayEmojis.map((e) => (
              <button
                key={e.name}
                onClick={() => onSelect(e.emoji)}
                className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-bg-tertiary/50 transition-colors text-lg"
                title={e.name}
              >
                {e.emoji}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
