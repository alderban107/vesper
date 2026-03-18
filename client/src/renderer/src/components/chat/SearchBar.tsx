import { createPortal } from 'react-dom'
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { Clock3, CornerDownLeft, Hash, Search, Volume2, X } from 'lucide-react'
import { useMessageStore, type RecallSearchResult } from '../../stores/messageStore'
import { useServerStore, type Server } from '../../stores/serverStore'
import { useDmStore, type DmConversation } from '../../stores/dmStore'
import { usePresenceStore } from '../../stores/presenceStore'
import { useAuthStore } from '../../stores/authStore'
import Avatar from '../ui/Avatar'

const RECENT_RECALL_QUERIES_KEY = 'vesper:recallRecentQueries'
const MAX_RECENT_RECALL_QUERIES = 8
const MAX_SECTION_ITEMS = 6
const MIN_RECALL_QUERY_LENGTH = 2

interface RecentQueryItem {
  id: string
  kind: 'recent-query'
  query: string
}

interface ChannelItem {
  id: string
  kind: 'channel'
  label: string
  sublabel: string
  channelId: string
  serverId: string
  channelType: 'text' | 'voice'
}

interface ConversationItem {
  id: string
  kind: 'conversation'
  label: string
  sublabel?: string
  conversationId: string
  avatarUrl?: string | null
  userId: string
}

interface ServerItem {
  id: string
  kind: 'server'
  label: string
  sublabel?: string
  serverId: string
  iconUrl?: string | null
}

interface RecallItem {
  id: string
  kind: 'recall'
  result: RecallSearchResult
}

type DestinationItem = ChannelItem | ConversationItem | ServerItem
type PaletteItem = RecentQueryItem | DestinationItem | RecallItem

interface PaletteSection {
  id: string
  title: string
  items: PaletteItem[]
}

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

function highlightText(text: string, query: string): React.JSX.Element {
  const normalized = query.trim().toLowerCase()
  if (!normalized) {
    return <>{text}</>
  }

  const lower = text.toLowerCase()
  const index = lower.indexOf(normalized)
  if (index === -1) {
    return <>{text}</>
  }

  return (
    <>
      {text.slice(0, index)}
      <span className="vesper-search-match">{text.slice(index, index + normalized.length)}</span>
      {text.slice(index + normalized.length)}
    </>
  )
}

function renderPreview(preview: string): React.JSX.Element {
  const parts = preview.split(/(\[\[\[.*?\]\]\])/g).filter(Boolean)

  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith('[[[') && part.endsWith(']]]')) {
          return (
            <mark key={`${part}-${index}`} className="vesper-search-preview-highlight">
              {part.slice(3, -3)}
            </mark>
          )
        }

        return <span key={`${part}-${index}`}>{part}</span>
      })}
    </>
  )
}

function getConversationLabel(conversation: DmConversation, currentUserId: string | null): string {
  if (conversation.name) {
    return conversation.name
  }

  const others = conversation.participants.filter((participant) => participant.user_id !== currentUserId)
  if (others.length === 0) {
    return 'Saved Messages'
  }

  return others
    .map((participant) => participant.user.display_name || participant.user.username)
    .filter(Boolean)
    .join(', ')
}

function getConversationMeta(conversation: DmConversation, currentUserId: string | null): {
  userId: string
  avatarUrl?: string | null
  subtitle?: string
} {
  const other = conversation.participants.find((participant) => participant.user_id !== currentUserId)
  return {
    userId: other?.user_id ?? conversation.id,
    avatarUrl: other?.user.avatar_url,
    subtitle: other ? `@${other.user.username}` : 'Private space'
  }
}

function matchesQuery(label: string, sublabel: string | undefined, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) {
    return true
  }

  return (
    label.toLowerCase().includes(normalized) ||
    (sublabel ? sublabel.toLowerCase().includes(normalized) : false)
  )
}

function buildSuggestedSections(
  recentQueries: string[],
  conversations: DmConversation[],
  currentUserId: string | null,
  activeServerId: string | null,
  servers: Server[]
): PaletteSection[] {
  const sections: PaletteSection[] = []

  if (recentQueries.length > 0) {
    sections.push({
      id: 'recent-queries',
      title: 'Recent Searches',
      items: recentQueries.map((query) => ({
        id: `recent:${query}`,
        kind: 'recent-query',
        query
      }))
    })
  }

  const activeServer = servers.find((server) => server.id === activeServerId) ?? null
  const activeServerItems: ChannelItem[] = (activeServer?.channels ?? [])
    .filter((channel) => channel.type === 'text' || channel.type === 'voice')
    .slice(0, MAX_SECTION_ITEMS)
    .map((channel) => ({
      id: `channel:${channel.id}`,
      kind: 'channel',
      label: channel.name,
      sublabel: activeServer?.name ?? 'Channel',
      channelId: channel.id,
      serverId: activeServer?.id ?? '',
      channelType: channel.type === 'voice' ? 'voice' : 'text'
    }))

  if (activeServerItems.length > 0) {
    sections.push({
      id: 'server-channels',
      title: activeServer ? `${activeServer.name} Channels` : 'Channels',
      items: activeServerItems
    })
  }

  const dmItems: ConversationItem[] = conversations
    .slice(0, MAX_SECTION_ITEMS)
    .map((conversation) => {
      const meta = getConversationMeta(conversation, currentUserId)
      return {
        id: `conversation:${conversation.id}`,
        kind: 'conversation',
        label: getConversationLabel(conversation, currentUserId),
        sublabel: meta.subtitle,
        conversationId: conversation.id,
        avatarUrl: meta.avatarUrl,
        userId: meta.userId
      }
    })

  if (dmItems.length > 0) {
    sections.push({
      id: 'direct-messages',
      title: 'Direct Messages',
      items: dmItems
    })
  }

  return sections
}

export default function SearchBar(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [recallResults, setRecallResults] = useState<RecallSearchResult[]>([])
  const [isOpen, setIsOpen] = useState(false)
  const [searchingRecall, setSearchingRecall] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [recentQueries, setRecentQueries] = useState<string[]>(() => readRecentQueries())
  const searchMessages = useMessageStore((s) => s.searchMessages)
  const setPendingJumpTarget = useMessageStore((s) => s.setPendingJumpTarget)
  const servers = useServerStore((s) => s.servers)
  const activeServerId = useServerStore((s) => s.activeServerId)
  const setActiveServer = useServerStore((s) => s.setActiveServer)
  const setActiveChannel = useServerStore((s) => s.setActiveChannel)
  const selectConversation = useDmStore((s) => s.selectConversation)
  const conversations = useDmStore((s) => s.conversations)
  const currentUserId = useAuthStore((s) => s.user?.id ?? null)
  const getPresenceStatus = usePresenceStore((s) => s.getStatus)
  const inputRef = useRef<HTMLInputElement | null>(null)

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
      setRecallResults([])
      setSearchingRecall(false)
      return
    }

    const trimmed = deferredQuery.trim()
    if (trimmed.length < MIN_RECALL_QUERY_LENGTH) {
      setRecallResults([])
      setSearchingRecall(false)
      return
    }

    let cancelled = false
    setSearchingRecall(true)

    const timeoutId = window.setTimeout(() => {
      void (async () => {
        const found = await searchMessages(trimmed)
        if (!cancelled) {
          setRecallResults(found)
          setSearchingRecall(false)
        }
      })()
    }, 120)

    return () => {
      cancelled = true
      window.clearTimeout(timeoutId)
    }
  }, [deferredQuery, isOpen, searchMessages])

  const navigationSections = useMemo(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      return buildSuggestedSections(
        recentQueries,
        conversations,
        currentUserId,
        activeServerId,
        servers
      )
    }

    const channelItems: ChannelItem[] = []
    const serverItems: ServerItem[] = []

    for (const server of servers) {
      if (matchesQuery(server.name, undefined, trimmed)) {
        serverItems.push({
          id: `server:${server.id}`,
          kind: 'server',
          label: server.name,
          sublabel: `${server.channels.filter((channel) => channel.type !== 'category').length} channels`,
          serverId: server.id,
          iconUrl: server.icon_url
        })
      }

      for (const channel of server.channels) {
        if (channel.type !== 'text' && channel.type !== 'voice') {
          continue
        }

        if (!matchesQuery(channel.name, channel.topic || server.name, trimmed)) {
          continue
        }

        channelItems.push({
          id: `channel:${channel.id}`,
          kind: 'channel',
          label: channel.name,
          sublabel: server.name,
          channelId: channel.id,
          serverId: server.id,
          channelType: channel.type === 'voice' ? 'voice' : 'text'
        })
      }
    }

    const conversationItems: ConversationItem[] = conversations
      .map((conversation) => {
        const label = getConversationLabel(conversation, currentUserId)
        const meta = getConversationMeta(conversation, currentUserId)
        return {
          id: `conversation:${conversation.id}`,
          kind: 'conversation' as const,
          label,
          sublabel: meta.subtitle,
          conversationId: conversation.id,
          avatarUrl: meta.avatarUrl,
          userId: meta.userId
        }
      })
      .filter((item) => matchesQuery(item.label, item.sublabel, trimmed))

    const sections: PaletteSection[] = []

    if (channelItems.length > 0) {
      sections.push({
        id: 'channels',
        title: 'Channels',
        items: channelItems.slice(0, MAX_SECTION_ITEMS)
      })
    }

    if (conversationItems.length > 0) {
      sections.push({
        id: 'conversations',
        title: 'Direct Messages',
        items: conversationItems.slice(0, MAX_SECTION_ITEMS)
      })
    }

    if (serverItems.length > 0) {
      sections.push({
        id: 'servers',
        title: 'Servers',
        items: serverItems.slice(0, MAX_SECTION_ITEMS)
      })
    }

    return sections
  }, [activeServerId, conversations, currentUserId, query, recentQueries, servers])

  const recallSection = useMemo<PaletteSection | null>(() => {
    if (query.trim().length < MIN_RECALL_QUERY_LENGTH) {
      return null
    }

    return {
      id: 'recall',
      title: 'Message Recall',
      items: recallResults.map((result) => ({
        id: `recall:${result.id}`,
        kind: 'recall',
        result
      }))
    }
  }, [query, recallResults])

  const sections = useMemo(() => {
    if (!recallSection) {
      return navigationSections
    }

    return [...navigationSections, recallSection]
  }, [navigationSections, recallSection])

  const flatItems = useMemo(
    () => sections.flatMap((section) => section.items),
    [sections]
  )

  useEffect(() => {
    if (flatItems.length === 0) {
      setSelectedIndex(0)
      return
    }

    setSelectedIndex((current) => Math.min(current, flatItems.length - 1))
  }, [flatItems.length])

  const closePalette = (): void => {
    setIsOpen(false)
    setQuery('')
    setRecallResults([])
    setSearchingRecall(false)
    setSelectedIndex(0)
  }

  const handleRecallClick = (result: RecallSearchResult): void => {
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

    if (didNavigate) {
      setRecentQueries(pushRecentQuery(query))
      closePalette()
    }
  }

  const handleDestinationClick = (item: DestinationItem): void => {
    if (item.kind === 'channel') {
      selectConversation(null)
      setActiveServer(item.serverId)
      setActiveChannel(item.channelId)
    } else if (item.kind === 'conversation') {
      setActiveServer(null)
      setActiveChannel(null)
      selectConversation(item.conversationId)
    } else {
      selectConversation(null)
      setActiveServer(item.serverId)
    }

    if (query.trim()) {
      setRecentQueries(pushRecentQuery(query))
    }
    closePalette()
  }

  const handleItemSelect = (item: PaletteItem): void => {
    if (item.kind === 'recent-query') {
      setQuery(item.query)
      return
    }

    if (item.kind === 'recall') {
      handleRecallClick(item.result)
      return
    }

    handleDestinationClick(item)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closePalette()
      return
    }

    if (!flatItems.length) {
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelectedIndex((current) => (current + 1) % flatItems.length)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelectedIndex((current) => (current - 1 + flatItems.length) % flatItems.length)
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      const item = flatItems[selectedIndex]
      if (item) {
        handleItemSelect(item)
      }
    }
  }

  const describeLocation = (result: RecallSearchResult): string => {
    if (result.conversation_id) {
      const conversation = conversations.find((entry) => entry.id === result.conversation_id)
      return conversation ? getConversationLabel(conversation, currentUserId) : 'Direct message'
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

  const paletteOverlay = isOpen && typeof document !== 'undefined'
    ? createPortal(
        <div
          className="vesper-search-palette-overlay"
          onClick={closePalette}
        >
          <div
            className="vesper-search-palette"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="vesper-search-palette-header">
              <Search className="h-4 w-4 text-text-faint shrink-0" />
              <input
                data-testid="search-input"
                ref={inputRef}
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Jump to channels, DMs, servers, or search local recall"
                className="vesper-search-palette-input"
              />
              <div className="hidden sm:block vesper-search-palette-hint">
                Ctrl/Cmd+K
              </div>
              <button
                type="button"
                onClick={closePalette}
                className="vesper-search-palette-close"
                title="Close quick switcher"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="vesper-search-palette-results" data-testid="search-results">
              {searchingRecall && query.trim().length >= MIN_RECALL_QUERY_LENGTH && (
                <div className="vesper-search-empty">Searching your local recall index...</div>
              )}

              {!searchingRecall && sections.length === 0 && query.trim() && (
                <div className="vesper-search-empty">
                  No channels, DMs, servers, or local recall results match this search yet.
                </div>
              )}

              {sections.map((section) => (
                <div key={section.id} className="vesper-search-section">
                  <div className="vesper-search-section-title">{section.title}</div>
                  <div className="vesper-search-section-list">
                    {section.items.map((item) => {
                      const index = flatItems.findIndex((entry) => entry.id === item.id)
                      const selected = index === selectedIndex

                      if (item.kind === 'recent-query') {
                        return (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => setQuery(item.query)}
                            className={selected ? 'vesper-search-row vesper-search-row-selected' : 'vesper-search-row'}
                          >
                            <div className="vesper-search-row-icon">
                              <Clock3 className="h-4 w-4" />
                            </div>
                            <div className="vesper-search-row-copy">
                              <div className="vesper-search-row-label">{item.query}</div>
                            </div>
                            <CornerDownLeft className="h-3.5 w-3.5 text-text-faint shrink-0" />
                          </button>
                        )
                      }

                      if (item.kind === 'recall') {
                        return (
                          <button
                            data-testid="search-result"
                            key={item.id}
                            type="button"
                            onClick={() => handleRecallClick(item.result)}
                            className={selected ? 'vesper-search-row vesper-search-row-selected' : 'vesper-search-row'}
                          >
                            <div className="vesper-search-row-copy">
                              <div className="vesper-search-row-meta">
                                <span className="truncate">{describeLocation(item.result)}</span>
                                <span className="text-text-disabled">•</span>
                                <span>{new Date(item.result.inserted_at).toLocaleString()}</span>
                              </div>
                              <div className="vesper-search-row-label">
                                {item.result.sender?.display_name || item.result.sender?.username || item.result.sender_id || 'Unknown sender'}
                              </div>
                              <div className="vesper-search-row-preview">
                                {renderPreview(item.result.search_preview || item.result.content)}
                              </div>
                            </div>
                          </button>
                        )
                      }

                      return (
                        <button
                          data-testid="search-result"
                          key={item.id}
                          type="button"
                          onClick={() => handleDestinationClick(item)}
                          className={selected ? 'vesper-search-row vesper-search-row-selected' : 'vesper-search-row'}
                        >
                          <div className="vesper-search-row-icon">
                            {item.kind === 'conversation' ? (
                              <Avatar
                                userId={item.userId}
                                avatarUrl={item.avatarUrl}
                                displayName={item.label}
                                size="sm"
                                status={getPresenceStatus(item.userId)}
                              />
                            ) : item.kind === 'channel' ? (
                              item.channelType === 'voice' ? <Volume2 className="h-4 w-4" /> : <Hash className="h-4 w-4" />
                            ) : item.iconUrl ? (
                              <img src={item.iconUrl} alt="" className="vesper-search-server-icon" />
                            ) : (
                              <span className="vesper-search-server-fallback">
                                {item.label.slice(0, 1).toUpperCase()}
                              </span>
                            )}
                          </div>
                          <div className="vesper-search-row-copy">
                            <div className="vesper-search-row-label">
                              {highlightText(item.label, query)}
                            </div>
                            {item.sublabel && (
                              <div className="vesper-search-row-sublabel">
                                {highlightText(item.sublabel, query)}
                              </div>
                            )}
                          </div>
                          {selected && (
                            <span className="vesper-search-row-enter">Enter</span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>

            <div className="vesper-search-palette-footer">
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd>
                move
              </span>
              <span>
                <kbd>Enter</kbd>
                open
              </span>
              <span>
                <kbd>Esc</kbd>
                close
              </span>
              <span className="vesper-search-palette-footer-note">
                Recall results come from messages decrypted on this device.
              </span>
            </div>
          </div>
        </div>,
        document.body
      )
    : null

  return (
    <>
      <button
        data-testid="search-button"
        type="button"
        onClick={() => setIsOpen(true)}
        className="text-text-faint hover:text-text-primary p-1.5 rounded hover:bg-bg-tertiary/50 transition-colors"
        title="Quick Switcher"
      >
        <Search className="w-4 h-4" />
      </button>

      {paletteOverlay}
    </>
  )
}
