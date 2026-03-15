import { useEffect, useRef, useState } from 'react'
import {
  ArrowRightToLine,
  Check,
  ChevronDown,
  Copy,
  Pencil,
  Folder,
  GripVertical,
  Hash,
  Link,
  LogOut,
  MessageCircle,
  Plus,
  Settings,
  Trash2,
  Volume2
} from 'lucide-react'
import { apiFetch } from '../../api/client'
import { useAuthStore } from '../../stores/authStore'
import { useDmStore } from '../../stores/dmStore'
import { usePresenceStore } from '../../stores/presenceStore'
import { type Channel, useServerStore } from '../../stores/serverStore'
import { useUIStore } from '../../stores/uiStore'
import { useUnreadStore } from '../../stores/unreadStore'
import { useVoiceStore } from '../../stores/voiceStore'
import { useContextMenu } from '../../hooks/useContextMenu'
import DmSidebar from '../dm/DmSidebar'
import ProfilePopout from '../profile/ProfilePopout'
import ContextMenu, { type ContextMenuItem } from '../ui/ContextMenu'
import VoiceParticipants from '../voice/VoiceParticipants'
import AccountPanel from './AccountPanel'
import PanelShell from './PanelShell'

type View = 'server' | 'dm'
type DragState =
  | { type: 'category'; id: string }
  | { type: 'channel'; id: string; categoryId: string | null }
type ChannelSection = {
  id: string
  label: string
  category: Channel | null
  channels: Channel[]
}

const CHANNEL_COLLAPSE_STORAGE_KEY = 'vesper:channelCollapseState'

function readCollapsedSections(): Record<string, boolean> {
  if (typeof window === 'undefined') {
    return {}
  }

  try {
    const raw = window.localStorage.getItem(CHANNEL_COLLAPSE_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed as Record<string, boolean> : {}
  } catch {
    return {}
  }
}

function sortChannels(channels: Channel[]): Channel[] {
  return [...channels].sort(
    (left, right) => left.position - right.position || left.name.localeCompare(right.name)
  )
}

function isLegacyDefaultCategory(category: Channel, kind: 'text' | 'voice'): boolean {
  const normalized = category.name.trim().toLowerCase()
  return kind === 'text' ? normalized === 'text channels' : normalized === 'voice channels'
}

function buildSections(channels: Channel[]): ChannelSection[] {
  const categories = sortChannels(channels.filter((channel) => channel.type === 'category'))
  const regularChannels = sortChannels(channels.filter((channel) => channel.type !== 'category'))
  const byCategory = new Map<string, Channel[]>()

  for (const channel of regularChannels) {
    if (!channel.category_id) {
      continue
    }

    const existing = byCategory.get(channel.category_id) ?? []
    existing.push(channel)
    byCategory.set(channel.category_id, existing)
  }

  const sections = categories.map((category) => ({
    id: category.id,
    label: category.name,
    category,
    channels: byCategory.get(category.id) ?? []
  }))

  const uncategorizedText = regularChannels.filter(
    (channel) => channel.type === 'text' && !channel.category_id
  )
  const uncategorizedVoice = regularChannels.filter(
    (channel) => channel.type === 'voice' && !channel.category_id
  )

  const filteredSections = sections.filter((section) => {
    if (!section.category || section.channels.length > 0) {
      return true
    }

    if (uncategorizedText.length > 0 && isLegacyDefaultCategory(section.category, 'text')) {
      return false
    }

    if (uncategorizedVoice.length > 0 && isLegacyDefaultCategory(section.category, 'voice')) {
      return false
    }

    return true
  })
  const hasVisibleCategories = filteredSections.some((section) => section.category !== null)

  if (uncategorizedText.length > 0) {
    filteredSections.push({
      id: 'root-text',
      label: hasVisibleCategories ? 'Uncategorized Text' : 'Text Channels',
      category: null,
      channels: uncategorizedText
    })
  }

  if (uncategorizedVoice.length > 0) {
    filteredSections.push({
      id: 'root-voice',
      label: hasVisibleCategories ? 'Uncategorized Voice' : 'Voice Channels',
      category: null,
      channels: uncategorizedVoice
    })
  }

  return filteredSections
}

function getScopedChannelDraft(section: ChannelSection): {
  type: 'text' | 'voice' | 'category'
  categoryId: string | null
  scopeLabel: string | null
} {
  if (section.category) {
    const firstChannel = section.channels[0]
    return {
      type: firstChannel?.type === 'voice' ? 'voice' : 'text',
      categoryId: section.category.id,
      scopeLabel: section.category.name
    }
  }

  if (section.id === 'root-voice') {
    return {
      type: 'voice',
      categoryId: null,
      scopeLabel: 'Voice Channels'
    }
  }

  return {
    type: 'text',
    categoryId: null,
    scopeLabel: section.label
  }
}

export default function Sidebar(): React.JSX.Element {
  const servers = useServerStore((s) => s.servers)
  const activeServerId = useServerStore((s) => s.activeServerId)
  const activeChannelId = useServerStore((s) => s.activeChannelId)
  const setActiveServer = useServerStore((s) => s.setActiveServer)
  const setActiveChannel = useServerStore((s) => s.setActiveChannel)
  const deleteChannel = useServerStore((s) => s.deleteChannel)
  const updateChannel = useServerStore((s) => s.updateChannel)
  const openCreateServerModal = useUIStore((s) => s.openCreateServerModal)
  const openJoinServerModal = useUIStore((s) => s.openJoinServerModal)
  const openCreateChannelModal = useUIStore((s) => s.openCreateChannelModal)
  const openSettingsModal = useUIStore((s) => s.openSettingsModal)
  const openServerSettingsModal = useUIStore((s) => s.openServerSettingsModal)
  const openChannelSettingsModal = useUIStore((s) => s.openChannelSettingsModal)
  const closeMobileNav = useUIStore((s) => s.closeMobileNav)
  const channelSidebarWidth = useUIStore((s) => s.channelSidebarWidth)
  const setChannelSidebarWidth = useUIStore((s) => s.setChannelSidebarWidth)
  const logout = useAuthStore((s) => s.logout)
  const user = useAuthStore((s) => s.user)
  const leaveServer = useServerStore((s) => s.leaveServer)
  const selectedConversationId = useDmStore((s) => s.selectedConversationId)
  const selectConversation = useDmStore((s) => s.selectConversation)
  const fetchConversations = useDmStore((s) => s.fetchConversations)
  const channelUnreads = useUnreadStore((s) => s.channelUnreads)
  const dmUnreads = useUnreadStore((s) => s.dmUnreads)
  const serverMenu = useContextMenu<string>()
  const channelMenu = useContextMenu<{ channelId: string; serverId: string }>()
  const [serverHeaderOpen, setServerHeaderOpen] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>(
    () => readCollapsedSections()
  )
  const [dragState, setDragState] = useState<DragState | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const serverHeaderRef = useRef<HTMLDivElement | null>(null)

  const currentView: View = !activeServerId ? 'dm' : 'server'
  const activeServer = servers.find((server) => server.id === activeServerId)
  const isMobileLayout = typeof window !== 'undefined' && window.innerWidth <= 768
  const isServerOwner = activeServer?.owner_id === user?.id
  const sections = buildSections(activeServer?.channels ?? [])
  const sortedCategories = sortChannels(
    (activeServer?.channels ?? []).filter((channel) => channel.type === 'category')
  )

  useEffect(() => {
    if (!serverHeaderOpen) {
      return
    }

    const handlePointerDown = (event: MouseEvent): void => {
      if (!serverHeaderRef.current?.contains(event.target as Node)) {
        setServerHeaderOpen(false)
      }
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setServerHeaderOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [serverHeaderOpen])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    window.localStorage.setItem(CHANNEL_COLLAPSE_STORAGE_KEY, JSON.stringify(collapsedSections))
  }, [collapsedSections])

  useEffect(() => {
    if (!activeServer || !activeChannelId) {
      return
    }

    const activeChannel = activeServer.channels.find((channel) => channel.id === activeChannelId)
    if (!activeChannel?.category_id) {
      return
    }

    setCollapsedSections((currentState) =>
      currentState[activeChannel.category_id!]
        ? { ...currentState, [activeChannel.category_id!]: false }
        : currentState
    )
  }, [activeChannelId, activeServer])

  const handleServerClick = (serverId: string): void => {
    selectConversation(null)
    setActiveServer(serverId)
    setServerHeaderOpen(false)
    if (isMobileLayout) {
      closeMobileNav()
    }
  }

  const handleDmClick = (): void => {
    setActiveServer(null)
    setActiveChannel(null)
    fetchConversations()
    setServerHeaderOpen(false)
    if (isMobileLayout) {
      closeMobileNav()
    }
  }

  const handleChannelSelect = (channelId: string): void => {
    setActiveChannel(channelId)
    setServerHeaderOpen(false)
    if (isMobileLayout) {
      closeMobileNav()
    }
  }

  const clearDragState = (): void => {
    setDragState(null)
    setDropTarget(null)
  }

  const moveCategory = async (categoryId: string, targetIndex: number): Promise<void> => {
    if (!activeServer) {
      return
    }

    const currentIndex = sortedCategories.findIndex((category) => category.id === categoryId)
    if (currentIndex === -1) {
      return
    }

    const boundedIndex = Math.max(0, Math.min(targetIndex, sortedCategories.length - 1))
    if (boundedIndex === currentIndex) {
      return
    }

    await updateChannel(activeServer.id, categoryId, { position: boundedIndex })
  }

  const moveChannel = async (
    channelId: string,
    categoryId: string | null,
    targetIndex: number
  ): Promise<void> => {
    if (!activeServer) {
      return
    }

    const destinationChannels = sortChannels(
      activeServer.channels.filter(
        (channel) =>
          channel.type !== 'category' &&
          channel.id !== channelId &&
          (categoryId ? channel.category_id === categoryId : !channel.category_id)
      )
    )

    const boundedIndex = Math.max(0, Math.min(targetIndex, destinationChannels.length))
    await updateChannel(activeServer.id, channelId, {
      category_id: categoryId,
      position: boundedIndex
    })
  }

  const getServerItems = (serverId: string): ContextMenuItem[] => {
    const server = servers.find((item) => item.id === serverId)
    const isOwner = server?.owner_id === user?.id

    return [
      ...(isOwner
        ? [
            {
              label: 'Server Settings',
              icon: Settings,
              onClick: () => {
                handleServerClick(serverId)
                openServerSettingsModal()
              }
            }
          ]
        : []),
      {
        label: 'Copy Server ID',
        icon: Copy,
        onClick: () => navigator.clipboard.writeText(serverId)
      },
      {
        label: 'Leave Server',
        icon: LogOut,
        onClick: () => leaveServer(serverId),
        danger: true,
        divider: true,
        disabled: isOwner
      }
    ]
  }

  const getChannelItems = (channelId: string, serverId: string): ContextMenuItem[] => {
    const server = servers.find((item) => item.id === serverId)
    const channel = server?.channels.find((item) => item.id === channelId)
    const isOwner = server?.owner_id === user?.id

    return [
      ...(isOwner
        ? [
            {
              label: channel?.type === 'category' ? 'Edit Category' : 'Channel Settings',
              icon: Pencil,
              onClick: () => openChannelSettingsModal(channelId)
            },
            {
              label: channel?.type === 'category' ? 'Delete Category' : 'Delete Channel',
              icon: Trash2,
              onClick: () => deleteChannel(serverId, channelId),
              danger: true,
              divider: true
            }
          ]
        : []),
      {
        label: 'Copy ID',
        icon: Copy,
        onClick: () => navigator.clipboard.writeText(channelId),
        divider: isOwner
      }
    ]
  }

  const totalDmUnread = Object.values(dmUnreads).reduce((sum, count) => sum + count, 0)

  return (
    <div data-testid="sidebar" className="flex h-full">
      <div className="w-[72px] bg-bg-base flex flex-col items-center py-3 gap-2">
        <div className="relative">
          {currentView === 'dm' && (
            <div className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1 w-1 h-8 bg-accent rounded-r-full" />
          )}
          <button
            onClick={handleDmClick}
            title="Direct Messages"
            className={`relative w-12 h-12 flex items-center justify-center transition-all duration-200 ${
              currentView === 'dm'
                ? 'bg-accent text-bg-base rounded-2xl'
                : 'bg-bg-secondary text-text-muted hover:bg-accent/20 hover:text-accent rounded-[24px] hover:rounded-2xl'
            }`}
          >
            <MessageCircle className="w-5 h-5" />
            {totalDmUnread > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1">
                {totalDmUnread > 99 ? '99+' : totalDmUnread}
              </span>
            )}
          </button>
        </div>

        <div className="w-8 h-0.5 bg-border rounded-full" />

        {servers.map((server) => {
          const isActive = server.id === activeServerId && currentView === 'server'
          const serverUnread = server.channels.reduce(
            (sum, channel) => sum + (channelUnreads[channel.id] || 0),
            0
          )

          return (
            <div key={server.id} className="relative" data-testid="server-row">
              {isActive && (
                <div className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1 w-1 h-8 bg-accent rounded-r-full" />
              )}
              <button
                data-testid="server-row"
                onClick={() => handleServerClick(server.id)}
                onContextMenu={(event) => serverMenu.onContextMenu(event, server.id)}
                title={server.name}
                className={`relative w-12 h-12 flex items-center justify-center text-sm font-semibold transition-all duration-200 ${
                  isActive
                    ? 'bg-accent text-bg-base rounded-2xl'
                    : 'bg-bg-secondary text-text-muted hover:bg-accent/20 hover:text-accent rounded-[24px] hover:rounded-2xl'
                }`}
              >
                {server.name.slice(0, 2).toUpperCase()}
                {serverUnread > 0 && !isActive && (
                  <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1">
                    {serverUnread > 99 ? '99+' : serverUnread}
                  </span>
                )}
              </button>
            </div>
          )
        })}

        <div className="flex-1" />

        <button
          onClick={openCreateServerModal}
          title="Create Server"
          className="w-12 h-12 rounded-[24px] bg-bg-secondary text-success hover:bg-success/10 hover:text-success flex items-center justify-center transition-all duration-200 hover:rounded-2xl"
        >
          <Plus className="w-5 h-5" />
        </button>
        <button
          onClick={openJoinServerModal}
          title="Join Server"
          className="w-12 h-12 rounded-[24px] bg-bg-secondary text-text-muted hover:bg-bg-tertiary hover:text-text-primary flex items-center justify-center transition-all duration-200 hover:rounded-2xl"
        >
          <ArrowRightToLine className="w-5 h-5" />
        </button>
      </div>

      <PanelShell
        side="right"
        width={channelSidebarWidth}
        onWidthChange={setChannelSidebarWidth}
      >
        {currentView === 'dm' ? (
          <DmSidebarContent />
        ) : (
          <div className="vesper-channel-sidebar">
            {activeServer ? (
              <>
                <div className="vesper-channel-sidebar-header" ref={serverHeaderRef}>
                  <button
                    type="button"
                    className={`vesper-guild-header-button${serverHeaderOpen ? ' vesper-guild-header-button-open' : ''}`}
                    onClick={() => setServerHeaderOpen((open) => !open)}
                    aria-expanded={serverHeaderOpen}
                    aria-haspopup="menu"
                  >
                    <div className="vesper-channel-sidebar-header-copy">
                      <span className="vesper-channel-sidebar-kicker">Server</span>
                      <h2 className="vesper-channel-sidebar-title">{activeServer.name}</h2>
                    </div>
                    <ChevronDown className={`vesper-guild-header-chevron${serverHeaderOpen ? ' vesper-guild-header-chevron-open' : ''}`} />
                  </button>
                  <InviteCodeButton serverId={activeServer.id} />

                  {serverHeaderOpen && (
                    <div className="vesper-guild-header-menu" role="menu" aria-label={`${activeServer.name} actions`}>
                      <button
                        type="button"
                        className="vesper-guild-header-menu-item"
                        onClick={() => {
                          navigator.clipboard.writeText(activeServer.id)
                          setServerHeaderOpen(false)
                        }}
                        role="menuitem"
                      >
                        <Copy className="w-4 h-4" />
                        <span>Copy Server ID</span>
                      </button>
                      {isServerOwner && (
                        <>
                          <button
                            type="button"
                            className="vesper-guild-header-menu-item"
                            onClick={() => {
                              setServerHeaderOpen(false)
                              openServerSettingsModal()
                            }}
                            role="menuitem"
                          >
                            <Settings className="w-4 h-4" />
                            <span>Server Settings</span>
                          </button>
                          <button
                            type="button"
                            className="vesper-guild-header-menu-item"
                            onClick={() => {
                              setServerHeaderOpen(false)
                              openCreateChannelModal()
                            }}
                            role="menuitem"
                          >
                            <Plus className="w-4 h-4" />
                            <span>Create Channel</span>
                          </button>
                        </>
                      )}
                      <div className="vesper-guild-header-menu-divider" />
                      <button
                        type="button"
                        className="vesper-guild-header-menu-item vesper-guild-header-menu-item-danger"
                        onClick={() => {
                          setServerHeaderOpen(false)
                          void leaveServer(activeServer.id)
                        }}
                        disabled={isServerOwner}
                        role="menuitem"
                      >
                        <LogOut className="w-4 h-4" />
                        <span>{isServerOwner ? 'Owner cannot leave' : 'Leave Server'}</span>
                      </button>
                    </div>
                  )}
                </div>

                <div className="vesper-channel-sidebar-scroller">
                  {isServerOwner && sortedCategories.length > 0 && (
                    <CategoryDropZone
                      active={dropTarget === 'category-zone-0'}
                      onDragEnter={() => dragState?.type === 'category' && setDropTarget('category-zone-0')}
                      onDragOver={(event) => {
                        if (dragState?.type === 'category') {
                          event.preventDefault()
                        }
                      }}
                      onDrop={async (event) => {
                        event.preventDefault()
                        if (dragState?.type === 'category') {
                          await moveCategory(dragState.id, 0)
                        }
                        clearDragState()
                      }}
                    />
                  )}

                  {sections.map((section, sectionIndex) => {
                    const isCollapsed = collapsedSections[section.id] === true
                    const isRealCategory = !!section.category

                    return (
                      <div
                        key={section.id}
                        className={`vesper-channel-group${isRealCategory ? ' vesper-channel-category-block' : ''}${dragState?.type === 'category' && section.category?.id === dragState.id ? ' vesper-channel-category-block-dragging' : ''}`}
                      >
                        <div
                          className="vesper-channel-group-header"
                          onContextMenu={(event) => {
                            if (section.category) {
                              channelMenu.onContextMenu(event, {
                                channelId: section.category.id,
                                serverId: activeServer.id
                              })
                            }
                          }}
                        >
                          {isRealCategory && isServerOwner && section.category && (
                            <span
                              className="vesper-channel-category-grip"
                              draggable
                              onDragStart={() => {
                                setDragState({ type: 'category', id: section.category!.id })
                              }}
                              onDragEnd={clearDragState}
                              title="Drag category"
                              aria-hidden="true"
                            >
                              <GripVertical className="w-3.5 h-3.5" />
                            </span>
                          )}
                          <button
                            type="button"
                            className="vesper-channel-category-toggle"
                            onClick={() =>
                              setCollapsedSections((currentState) => ({
                                ...currentState,
                                [section.id]: !currentState[section.id]
                              }))
                            }
                          >
                            <ChevronDown
                              className={`vesper-channel-category-chevron${isCollapsed ? ' vesper-channel-category-chevron-collapsed' : ''}`}
                            />
                            {isRealCategory && (
                              <span className="vesper-channel-category-icon" aria-hidden="true">
                                <Folder className="w-3.5 h-3.5" />
                              </span>
                            )}
                            <span className="vesper-channel-group-label">{section.label}</span>
                            <span className="vesper-channel-category-count">{section.channels.length}</span>
                          </button>
                          {isServerOwner && (
                            <div className="vesper-channel-group-actions">
                              {section.category && (
                                <button
                                  onClick={() => openChannelSettingsModal(section.category!.id)}
                                  className="vesper-channel-group-action"
                                  title="Edit Category"
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                              )}
                              <button
                                onClick={() => openCreateChannelModal(getScopedChannelDraft(section))}
                                className="vesper-channel-group-action"
                                title={
                                  section.category
                                    ? `Create channel in ${section.category.name}`
                                    : section.id === 'root-voice'
                                      ? 'Create voice channel'
                                      : 'Create text channel'
                                }
                              >
                                <Plus className="w-4 h-4" />
                              </button>
                            </div>
                          )}
                        </div>

                        {!isCollapsed && (
                          <div
                            className="vesper-channel-group-list"
                            onDragOver={(event) => {
                              if (dragState?.type === 'channel') {
                                event.preventDefault()
                              }
                            }}
                          >
                            {isServerOwner && (
                              <ChannelDropZone
                                active={dropTarget === `${section.id}-channel-zone-0`}
                                onDragEnter={() => dragState?.type === 'channel' && setDropTarget(`${section.id}-channel-zone-0`)}
                                onDrop={async (event) => {
                                  event.preventDefault()
                                  if (dragState?.type === 'channel') {
                                    await moveChannel(
                                      dragState.id,
                                      section.category?.id ?? null,
                                      0
                                    )
                                  }
                                  clearDragState()
                                }}
                              />
                            )}

                            {section.channels.map((channel, channelIndex) => {
                              const unread = channelUnreads[channel.id] || 0
                              const isActive = channel.id === activeChannelId
                              const isVoice = channel.type === 'voice'

                              return (
                                <div
                                  key={channel.id}
                                  className={`${isVoice ? 'vesper-channel-voice-block' : ''}${dragState?.type === 'channel' && dragState.id === channel.id ? ' vesper-channel-row-shell-dragging' : ''}`}
                                >
                                  <button
                                    data-testid="channel-row"
                                    draggable={isServerOwner}
                                    onDragStart={() =>
                                      isServerOwner &&
                                      setDragState({
                                        type: 'channel',
                                        id: channel.id,
                                        categoryId: channel.category_id ?? null
                                      })
                                    }
                                    onDragEnd={clearDragState}
                                    onContextMenu={(event) =>
                                      channelMenu.onContextMenu(event, {
                                        channelId: channel.id,
                                        serverId: activeServer.id
                                      })
                                    }
                                    onClick={() => {
                                      handleChannelSelect(channel.id)
                                      if (isVoice) {
                                        void useVoiceStore.getState().joinVoiceChannel(channel.id)
                                      }
                                    }}
                                    className={`vesper-channel-row${isActive ? ' vesper-channel-row-active' : ''}${unread > 0 && !isActive ? ' vesper-channel-row-unread' : ''}${isVoice ? ' vesper-channel-row-voice' : ''}`}
                                  >
                                    <span className="vesper-channel-row-icon">
                                      {isVoice ? (
                                        <Volume2 className="w-4 h-4 shrink-0" />
                                      ) : (
                                        <Hash className="w-4 h-4 shrink-0" />
                                      )}
                                    </span>
                                    <span className="vesper-channel-row-label">{channel.name}</span>
                                    {unread > 0 && !isActive && !isVoice && (
                                      <span className="vesper-channel-unread-badge">
                                        {unread > 99 ? '99+' : unread}
                                      </span>
                                    )}
                                    {isServerOwner && (
                                      <span
                                        className="vesper-channel-row-action"
                                        onClick={(event) => {
                                          event.stopPropagation()
                                          openChannelSettingsModal(channel.id)
                                        }}
                                        role="button"
                                        tabIndex={0}
                                        onKeyDown={(event) => {
                                          if (event.key === 'Enter' || event.key === ' ') {
                                            event.preventDefault()
                                            openChannelSettingsModal(channel.id)
                                          }
                                        }}
                                        title={isVoice ? 'Voice Channel Settings' : 'Channel Settings'}
                                      >
                                        <Pencil className="w-3.5 h-3.5" />
                                      </span>
                                    )}
                                  </button>
                                  {isVoice && !isActive && <VoiceParticipants channelId={channel.id} />}
                                  {isServerOwner && (
                                    <ChannelDropZone
                                      active={dropTarget === `${section.id}-channel-zone-${channelIndex + 1}`}
                                      onDragEnter={() =>
                                        dragState?.type === 'channel' &&
                                        setDropTarget(`${section.id}-channel-zone-${channelIndex + 1}`)
                                      }
                                      onDrop={async (event) => {
                                        event.preventDefault()
                                        if (dragState?.type === 'channel') {
                                          await moveChannel(
                                            dragState.id,
                                            section.category?.id ?? null,
                                            channelIndex + 1
                                          )
                                        }
                                        clearDragState()
                                      }}
                                    />
                                  )}
                                </div>
                              )
                            })}

                            {section.channels.length === 0 && section.category && (
                              <div className="vesper-channel-empty-state">
                                Drop channels here or create a new one.
                              </div>
                            )}
                          </div>
                        )}

                        {isServerOwner && section.category && (
                          <CategoryDropZone
                            active={dropTarget === `category-zone-${sectionIndex + 1}`}
                            onDragEnter={() => dragState?.type === 'category' && setDropTarget(`category-zone-${sectionIndex + 1}`)}
                            onDragOver={(event) => {
                              if (dragState?.type === 'category') {
                                event.preventDefault()
                              }
                            }}
                            onDrop={async (event) => {
                              event.preventDefault()
                              if (dragState?.type === 'category') {
                                await moveCategory(dragState.id, sectionIndex + 1)
                              }
                              clearDragState()
                            }}
                          />
                        )}
                      </div>
                    )
                  })}
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-text-faintest text-sm px-4 text-center">
                Select or create a server
              </div>
            )}

            <SidebarFooter user={user} logout={logout} openSettingsModal={openSettingsModal} />
          </div>
        )}
      </PanelShell>

      {serverMenu.menu && (
        <ContextMenu
          x={serverMenu.menu.x}
          y={serverMenu.menu.y}
          items={getServerItems(serverMenu.menu.data)}
          onClose={serverMenu.closeMenu}
        />
      )}
      {channelMenu.menu && (
        <ContextMenu
          x={channelMenu.menu.x}
          y={channelMenu.menu.y}
          items={getChannelItems(channelMenu.menu.data.channelId, channelMenu.menu.data.serverId)}
          onClose={channelMenu.closeMenu}
        />
      )}
    </div>
  )
}

function InviteCodeButton({ serverId }: { serverId: string }): React.JSX.Element | null {
  const [code, setCode] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(false)
  const [denied, setDenied] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const AUTO_HIDE_SECONDS = 15

  const clearTimer = (): void => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  const hideCode = (): void => {
    setVisible(false)
    setCode(null)
    setCountdown(0)
    clearTimer()
  }

  const startTimer = (): void => {
    clearTimer()
    setCountdown(AUTO_HIDE_SECONDS)
    timerRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          hideCode()
          return 0
        }
        return prev - 1
      })
    }, 1000)
  }

  const fetchAndShow = async (): Promise<void> => {
    if (visible) {
      hideCode()
      return
    }

    setLoading(true)
    try {
      const res = await apiFetch(`/api/v1/servers/${serverId}/invite-code`)
      if (res.ok) {
        const data = await res.json()
        setCode(data.invite_code)
        setVisible(true)
        startTimer()
      } else if (res.status === 403) {
        setDenied(true)
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  const copyCode = (): void => {
    if (!code) {
      return
    }

    navigator.clipboard.writeText(code)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
    // Reset timer on copy since the user is interacting
    startTimer()
  }

  useEffect(() => {
    setCode(null)
    setVisible(false)
    setCopied(false)
    setDenied(false)
    clearTimer()
  }, [serverId])

  useEffect(() => {
    return () => clearTimer()
  }, [])

  if (denied) {
    return null
  }

  return (
    <div className="flex items-center gap-1 shrink-0">
      {visible && code ? (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={copyCode}
            title={copied ? 'Copied!' : 'Copy invite code'}
            className="flex items-center gap-1 bg-bg-base/50 px-1.5 py-0.5 rounded border border-border hover:border-accent/50 transition-colors max-w-[100px]"
          >
            <code className="text-accent-text text-[10px] font-mono truncate">{code}</code>
            {copied ? (
              <Check className="w-3 h-3 text-emerald-400 shrink-0" />
            ) : (
              <Copy className="w-3 h-3 text-text-faint shrink-0" />
            )}
          </button>
          <button
            type="button"
            onClick={hideCode}
            title="Dismiss"
            className="text-text-faintest hover:text-text-muted transition-colors text-[10px] tabular-nums w-5 text-center"
          >
            {countdown}s
          </button>
        </div>
      ) : null}
      <button
        type="button"
        onClick={fetchAndShow}
        disabled={loading}
        title={visible ? 'Hide invite code' : 'Show invite code'}
        className="text-text-faint hover:text-text-primary transition-colors p-1 rounded hover:bg-bg-tertiary/50 disabled:opacity-40"
      >
        <Link className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

function ChannelDropZone({
  active,
  onDragEnter,
  onDrop
}: {
  active: boolean
  onDragEnter: () => void
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void | Promise<void>
}): React.JSX.Element {
  return (
    <div
      className={`vesper-channel-drop-zone${active ? ' vesper-channel-drop-zone-active' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    />
  )
}

function CategoryDropZone({
  active,
  onDragEnter,
  onDragOver,
  onDrop
}: {
  active: boolean
  onDragEnter: () => void
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void | Promise<void>
}): React.JSX.Element {
  return (
    <div
      className={`vesper-category-drop-zone${active ? ' vesper-category-drop-zone-active' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDrop={onDrop}
    />
  )
}

function DmSidebarContent(): React.JSX.Element {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const openSettingsModal = useUIStore((s) => s.openSettingsModal)

  return (
    <div className="vesper-channel-sidebar">
      <DmSidebar />
      <SidebarFooter user={user} logout={logout} openSettingsModal={openSettingsModal} />
    </div>
  )
}

function SidebarFooter({
  user,
  logout,
  openSettingsModal
}: {
  user: { id: string; username: string; display_name: string | null; avatar_url?: string | null } | null
  logout: () => void
  openSettingsModal: () => void
}): React.JSX.Element {
  const [profileAnchor, setProfileAnchor] = useState<DOMRect | null>(null)
  const myStatus = usePresenceStore((s) => s.myStatus)

  return (
    <>
      <AccountPanel
        user={user}
        logout={logout}
        openSettingsModal={openSettingsModal}
        onOpenProfile={(event) => setProfileAnchor(event.currentTarget.getBoundingClientRect())}
      />
      {user && profileAnchor && (
        <ProfilePopout
          user={{
            id: user.id,
            username: user.username,
            displayName: user.display_name || user.username,
            avatarUrl: user.avatar_url,
            status: myStatus,
            isCurrentUser: true
          }}
          anchorRect={profileAnchor}
          placement="top-right"
          onClose={() => setProfileAnchor(null)}
          onOpenSettings={() => {
            setProfileAnchor(null)
            openSettingsModal()
          }}
        />
      )}
    </>
  )
}
