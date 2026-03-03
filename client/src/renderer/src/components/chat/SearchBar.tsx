import { useState } from 'react'
import { Search, X } from 'lucide-react'
import { useMessageStore, type Message } from '../../stores/messageStore'

export default function SearchBar(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Message[]>([])
  const [isOpen, setIsOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const searchMessages = useMessageStore((s) => s.searchMessages)

  const handleSearch = async (): Promise<void> => {
    if (!query.trim()) return
    setSearching(true)
    const found = await searchMessages(query.trim())
    setResults(found)
    setSearching(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSearch()
    }
    if (e.key === 'Escape') {
      setIsOpen(false)
      setResults([])
      setQuery('')
    }
  }

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="text-text-faint hover:text-text-primary p-1.5 rounded hover:bg-bg-tertiary/50 transition-colors"
        title="Search messages"
      >
        <Search className="w-4 h-4" />
      </button>
    )
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-1">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-faint" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search messages..."
            autoFocus
            className="bg-bg-tertiary/50 text-text-primary text-sm pl-8 pr-3 py-1 rounded-lg border border-border input-focus w-48"
          />
        </div>
        <button
          onClick={() => {
            setIsOpen(false)
            setResults([])
            setQuery('')
          }}
          className="text-text-faint hover:text-text-primary p-1 rounded hover:bg-bg-tertiary/50 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {(results.length > 0 || searching) && (
        <div className="absolute top-full right-0 mt-1 w-80 max-h-64 overflow-y-auto glass-card rounded-xl z-50 animate-scale-in">
          {searching ? (
            <div className="p-3 text-text-faint text-sm text-center">Searching...</div>
          ) : (
            results.map((msg) => (
              <div
                key={msg.id}
                className="px-3 py-2 hover:bg-bg-tertiary/30 border-b border-border last:border-b-0 cursor-pointer transition-colors"
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-text-primary text-xs font-medium">
                    {msg.sender?.username || 'Unknown'}
                  </span>
                  <span className="text-text-faintest text-xs">
                    {new Date(msg.inserted_at).toLocaleDateString()}
                  </span>
                </div>
                <p className="text-text-secondary text-xs truncate mt-0.5">{msg.content}</p>
              </div>
            ))
          )}
          {!searching && results.length === 0 && query && (
            <div className="p-3 text-text-faint text-sm text-center">No results</div>
          )}
        </div>
      )}
    </div>
  )
}
