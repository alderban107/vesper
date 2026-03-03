import { useState, useEffect, useRef } from 'react'
import { useServerStore, type Member } from '../../stores/serverStore'

interface Props {
  query: string
  onSelect: (text: string, displayText: string) => void
  onClose: () => void
}

interface MentionOption {
  id: string
  label: string
  sublabel?: string
  mentionSyntax: string
  type: 'user' | 'everyone'
}

export default function MentionAutocomplete({ query, onSelect, onClose }: Props): React.JSX.Element | null {
  const members = useServerStore((s) => s.members)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const q = query.toLowerCase()

  const options: MentionOption[] = []

  // @everyone option
  if ('everyone'.startsWith(q) || q === '') {
    options.push({
      id: 'everyone',
      label: '@everyone',
      sublabel: 'Notify all members',
      mentionSyntax: '<@everyone>',
      type: 'everyone'
    })
  }

  // Member options
  for (const member of members) {
    const name = member.user?.display_name || member.user?.username || ''
    const username = member.user?.username || ''
    if (
      name.toLowerCase().includes(q) ||
      username.toLowerCase().includes(q)
    ) {
      options.push({
        id: member.user_id,
        label: name || username,
        sublabel: name !== username ? `@${username}` : undefined,
        mentionSyntax: `<@${member.user_id}>`,
        type: 'user'
      })
    }
  }

  // Limit to 8 results
  const filtered = options.slice(0, 8)

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.max(prev - 1, 0))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        if (filtered[selectedIndex]) {
          const opt = filtered[selectedIndex]
          onSelect(opt.mentionSyntax, opt.label)
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [filtered, selectedIndex, onSelect, onClose])

  // Scroll selected into view
  useEffect(() => {
    if (listRef.current) {
      const selected = listRef.current.children[selectedIndex] as HTMLElement
      if (selected) {
        selected.scrollIntoView({ block: 'nearest' })
      }
    }
  }, [selectedIndex])

  if (filtered.length === 0) return null

  return (
    <div
      ref={listRef}
      className="glass-card rounded-lg py-1 max-h-52 overflow-y-auto animate-scale-in w-64"
    >
      {filtered.map((opt, i) => (
        <button
          key={opt.id}
          onClick={() => onSelect(opt.mentionSyntax, opt.label)}
          className={`w-full text-left px-3 py-1.5 flex items-center gap-2 transition-colors ${
            i === selectedIndex
              ? 'bg-accent/10 text-text-primary'
              : 'text-text-secondary hover:bg-bg-tertiary/50'
          }`}
        >
          <div className="w-6 h-6 rounded-full bg-accent/20 flex items-center justify-center text-[10px] text-accent font-medium shrink-0">
            {opt.type === 'everyone' ? '@' : opt.label.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm truncate">{opt.label}</div>
            {opt.sublabel && (
              <div className="text-text-faintest text-[10px] truncate">{opt.sublabel}</div>
            )}
          </div>
        </button>
      ))}
    </div>
  )
}
