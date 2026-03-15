import { useEffect, useMemo, useRef, useState } from 'react'
import { Clock3, CornerDownLeft, Search, X } from 'lucide-react'
import { useMessageStore, type RecallSearchResult } from '../../stores/messageStore'
import { useServerStore } from '../../stores/serverStore'
import { useDmStore } from '../../stores/dmStore'

const RECENT_RECALL_QUERIES_KEY = 'vesper:recallRecentQueries'
const MAX_RECENT_RECALL_QUERIES = 8
const MIN_QUERY_LENGTH = 2

function readRecentQueries(): string[] {
  if (typeof window === 'undefined') {
    return []
  }

  try {
    const raw = window.localStorage.getItem(RECENT_RECALL_QUERIES_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string').slice(0, MAX_RECENT_RECALL_QUERIES)
      : []
  } catch {
    return []
  }
}

function writeRecentQueries(queries: string[]): void {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(
    RECENT_RECALL_QUERIES_KEY,
    JSON.stringify(queries.slice(0, MAX_RECENT_RECALL_QUERIES))
  )
}

function pushRecentQuery(query: string): string[] {
  const trimmed = query.trim()
  if (!trimmed) {
    return readRecentQueries()
  }

  const next = [trimmed, ...readRecentQueries().filter((entry) => entry !== trimmed)]
    .slice(0, MAX_RECENT_RECALL_QUERIES)
  writeRecentQueries(next)
  return next
}

function renderPreview(preview: string): React.JSX.Element {
  const parts = preview.split(/(\[\[\[.*?\]\]\])/g).filter(Boolean)

  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith('[[[') && part.endsWith(']]]')) {
          return (
            <mark key={`${part}-${index}`} className="bg-accent/20 text-accent-text rounded px-0.5">
              {part.slice(3, -3)}
            </mark>
          )
        }

        return <span key={`${part}-${index}`}>{part}</span>
      })}
    </>
  )
}

export default function SearchBar(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<RecallSearchResult[]>([])
  const [isOpen, setIsOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [recentQueries, setRecentQueries] = useState<string[]>(() => readRecentQueries())
  const searchMessages = useMessageStore((s) => s.searchMessages)
  const setPendingJumpTarget = useMessageStore((s) => s.setPendingJumpTarget)
  const servers = useServerStore((s) => s.servers)
  const setActiveServer = useServerStore((s) => s.setActiveServer)
  const setActiveChannel = useServerStore((s) => s.setActiveChannel)
  const selectConversation = useDmStore((s) => s.selectConversation)
  const conversations = useDmStore((s) => s.conversations)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const activeItems = useMemo(
    () => (query.trim() ? results : recentQueries.map((entry) => ({ id: entry, query: entry }))),
    [query, recentQueries, results]
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setIsOpen(true)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    if (!isOpen) {
      return
    }

    window.setTimeout(() => inputRef.current?.focus(), 0)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) {
      return
    }

    const trimmed = query.trim()
    if (!trimmed) {
      setResults([])
      setHasSearched(false)
      setError(null)
      setSelectedIndex(0)
      return
    }

    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([])
      setHasSearched(true)
      setError(`Type at least ${MIN_QUERY_LENGTH} characters`)
      setSelectedIndex(0)
      return
    }

    setSearching(true)
    setError(null)

    const timeoutId = window.setTimeout(() => {
      void (async () => {
        const found = await searchMessages(trimmed)
        setResults(found)
        setHasSearched(true)
        setSelectedIndex(0)
        setSearching(false)
      })()
    }, 120)

    return () => {
      window.clearTimeout(timeoutId)
      setSearching(false)
    }
  }, [isOpen, query, searchMessages])

  const closePalette = (): void => {
    setIsOpen(false)
    setQuery('')
    setResults([])
    setHasSearched(false)
    setError(null)
    setSelectedIndex(0)
  }

  const handleResultClick = (result: RecallSearchResult): void => {
    let didNavigate = false

    if (result.conversation_id) {
      setPendingJumpTarget({
        messageId: result.id,
        targetId: result.conversation_id,
        channelId: null,
        conversationId: result.conversation_id,
        serverId: null
      })
      setActiveServer(null)
      setActiveChannel(null)
      selectConversation(result.conversation_id)
      didNavigate = true
    } else if (result.channel_id) {
      const serverId =
        result.server_id ??
        servers.find((server) => server.channels.some((channel) => channel.id === result.channel_id))
          ?.id ??
        null

      if (serverId) {
        setPendingJumpTarget({
          messageId: result.id,
          targetId: result.channel_id,
          channelId: result.channel_id,
          conversationId: null,
          serverId
        })
        setActiveServer(serverId)
        selectConversation(null)
        setActiveChannel(result.channel_id)
        didNavigate = true
      }
    }

    if (!didNavigate) {
      setPendingJumpTarget(null)
      return
    }

    setRecentQueries(pushRecentQuery(query))
    closePalette()
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closePalette()
      return
    }

    if (!activeItems.length) {
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelectedIndex((current) => (current + 1) % activeItems.length)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelectedIndex((current) => (current - 1 + activeItems.length) % activeItems.length)
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      if (!query.trim()) {
        const recent = recentQueries[selectedIndex]
        if (recent) {
          setQuery(recent)
        }
        return
      }

      const result = results[selectedIndex]
      if (result) {
        handleResultClick(result)
      }
    }
  }

  const describeLocation = (result: RecallSearchResult): string => {
    if (result.conversation_id) {
      const conversation = conversations.find((entry) => entry.id === result.conversation_id)
      if (!conversation) {
        return 'Direct message'
      }

      if (conversation.name) {
        return conversation.name
      }

      const names = conversation.participants
        .map((participant) => participant.user.display_name || participant.user.username)
        .filter(Boolean)

      return names.length > 0 ? names.join(', ') : 'Direct message'
    }

    if (result.channel_id) {
      for (const server of servers) {
        const channel = server.channels.find((entry) => entry.id === result.channel_id)
        if (channel) {
          return `#${channel.name} in ${server.name}`
        }
      }
    }

    return 'Encrypted history'
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="text-text-faint hover:text-text-primary p-1.5 rounded hover:bg-bg-tertiary/50 transition-colors"
        title="Private recall"
      >
        <Search className="w-4 h-4" />
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-[90] bg-black/45 backdrop-blur-sm px-4 py-10"
          onClick={closePalette}
        >
          <div
            className="mx-auto mt-[8vh] w-full max-w-3xl overflow-hidden rounded-3xl border border-border bg-bg-secondary shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b border-border px-4 py-3">
              <Search className="h-4 w-4 text-text-faint shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Search your encrypted history"
                className="flex-1 bg-transparent text-base text-text-primary outline-none placeholder:text-text-faint"
              />
              <div className="hidden sm:block text-[11px] uppercase tracking-[0.22em] text-text-faint">
                Ctrl/Cmd+K
              </div>
              <button
                type="button"
                onClick={closePalette}
                className="rounded-lg p-1.5 text-text-faint hover:bg-bg-tertiary/50 hover:text-text-primary transition-colors"
                title="Close recall"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-[70vh] overflow-y-auto">
              {!query.trim() ? (
                <div className="p-4">
                  <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-text-faint">
                    <Clock3 className="h-3.5 w-3.5" />
                    Recent Queries
                  </div>
                  {recentQueries.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-border bg-bg-base/35 px-4 py-6 text-sm text-text-faint">
                      Recall searches stay on this device. Only messages decrypted here are searchable.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {recentQueries.map((recentQuery, index) => (
                        <button
                          key={recentQuery}
                          type="button"
                          onClick={() => setQuery(recentQuery)}
                          className={`flex w-full items-center justify-between rounded-2xl px-3 py-3 text-left transition-colors ${
                            index === selectedIndex
                              ? 'bg-bg-tertiary/70 text-text-primary'
                              : 'bg-bg-base/30 text-text-secondary hover:bg-bg-tertiary/45'
                          }`}
                        >
                          <span className="truncate">{recentQuery}</span>
                          <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-text-faint" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : searching ? (
                <div className="p-6 text-sm text-text-faint">Searching your local recall index...</div>
              ) : error ? (
                <div className="p-6 text-sm text-text-faint">{error}</div>
              ) : results.length === 0 && hasSearched ? (
                <div className="p-6 text-sm text-text-faint">
                  No local recall results yet. Messages become searchable after they have been decrypted on this device.
                </div>
              ) : (
                <div className="p-2">
                  {results.map((result, index) => (
                    <button
                      key={result.id}
                      type="button"
                      onClick={() => handleResultClick(result)}
                      className={`w-full rounded-2xl px-3 py-3 text-left transition-colors ${
                        index === selectedIndex
                          ? 'bg-bg-tertiary/70'
                          : 'hover:bg-bg-tertiary/45'
                      }`}
                    >
                      <div className="mb-1 flex items-center gap-2 text-xs text-text-faint">
                        <span className="truncate">{describeLocation(result)}</span>
                        <span className="text-text-disabled">•</span>
                        <span>{new Date(result.inserted_at).toLocaleString()}</span>
                      </div>
                      <div className="mb-1 text-sm font-medium text-text-primary">
                        {result.sender?.display_name || result.sender?.username || result.sender_id || 'Unknown sender'}
                      </div>
                      <div className="text-sm leading-6 text-text-secondary">
                        {renderPreview(result.search_preview || result.content)}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
