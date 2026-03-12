import { useState } from 'react'
import { Search, X } from 'lucide-react'
import { useMessageStore, type Message } from '../../stores/messageStore'
import { useServerStore } from '../../stores/serverStore'
import { useDmStore } from '../../stores/dmStore'

export default function SearchBar(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Message[]>([])
  const [isOpen, setIsOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const searchMessages = useMessageStore((s) => s.searchMessages)
  const setPendingJumpTarget = useMessageStore((s) => s.setPendingJumpTarget)
  const servers = useServerStore((s) => s.servers)
  const setActiveServer = useServerStore((s) => s.setActiveServer)
  const setActiveChannel = useServerStore((s) => s.setActiveChannel)
  const selectConversation = useDmStore((s) => s.selectConversation)

  const handleSearch = async (): Promise<void> => {
    const trimmed = query.trim()
    if (!trimmed) {
      setResults([])
      setHasSearched(false)
      setError(null)
      return
    }

    if (trimmed.length < 2) {
      setResults([])
      setHasSearched(true)
      setError('Type at least 2 characters')
      return
    }

    setError(null)
    setSearching(true)
    const found = await searchMessages(trimmed)
    setHasSearched(true)
    setResults(found)
    if (found.length === 0) {
      setError(null)
    }
    setSearching(false)
  }

  const handleResultClick = (message: Message): void => {
    let didNavigate = false

    if (message.conversation_id) {
      setPendingJumpTarget({
        messageId: message.id,
        targetId: message.conversation_id,
        channelId: null,
        conversationId: message.conversation_id,
        serverId: null
      })
      setActiveServer(null)
      setActiveChannel(null)
      selectConversation(message.conversation_id)
      didNavigate = true
    } else if (message.channel_id) {
      const serverId =
        message.server_id ??
        servers.find((server) => server.channels.some((channel) => channel.id === message.channel_id))
          ?.id ??
        null

      if (serverId) {
        setPendingJumpTarget({
          messageId: message.id,
          targetId: message.channel_id,
          channelId: message.channel_id,
          conversationId: null,
          serverId
        })
        setActiveServer(serverId)
        selectConversation(null)
        setActiveChannel(message.channel_id)
        didNavigate = true
      }
    }

    if (!didNavigate) {
      setPendingJumpTarget(null)
      return
    }

    setIsOpen(false)
    setQuery('')
    setResults([])
    setHasSearched(false)
    setError(null)
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
      setHasSearched(false)
      setError(null)
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
            placeholder="Search loaded messages..."
            autoFocus
            className="bg-bg-tertiary/50 text-text-primary text-sm pl-8 pr-3 py-1 rounded-lg border border-border input-focus w-48"
          />
        </div>
        <button
          onClick={() => {
            setIsOpen(false)
            setResults([])
            setQuery('')
            setHasSearched(false)
            setError(null)
          }}
          className="text-text-faint hover:text-text-primary p-1 rounded hover:bg-bg-tertiary/50 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {(results.length > 0 || searching || hasSearched || error) && (
        <div className="absolute top-full right-0 mt-1 w-80 max-h-64 overflow-y-auto glass-card rounded-xl z-50 animate-scale-in">
          {searching ? (
            <div className="p-3 text-text-faint text-sm text-center">Searching...</div>
          ) : error ? (
            <div className="p-3 text-text-faint text-sm text-center">{error}</div>
          ) : (
            results.map((msg) => (
              <div
                key={msg.id}
                className="px-3 py-2 hover:bg-bg-tertiary/30 border-b border-border last:border-b-0 cursor-pointer transition-colors"
                onClick={() => handleResultClick(msg)}
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-text-primary text-xs font-medium">
                    {msg.sender?.username || 'Unknown'}
                  </span>
                  <span className="text-text-faintest text-xs">
                    {new Date(msg.inserted_at).toLocaleDateString()}
                  </span>
                </div>
                <p className="text-text-secondary text-xs truncate mt-0.5">
                  {msg.content || msg.attachment_filenames?.join(', ') || 'Attachment'}
                </p>
              </div>
            ))
          )}
          {!searching && !error && hasSearched && results.length === 0 && (
            <div className="p-3 text-text-faint text-sm text-center">No results</div>
          )}
        </div>
      )}
    </div>
  )
}
