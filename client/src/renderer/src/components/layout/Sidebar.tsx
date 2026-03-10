import {
  MessageCircle, Plus, ArrowRightToLine, Hash, Volume2, Settings, LogOut,
  Copy, Trash2
} from 'lucide-react'
import { useServerStore } from '../../stores/serverStore'
import { useAuthStore } from '../../stores/authStore'
import { useDmStore } from '../../stores/dmStore'
import { useUIStore } from '../../stores/uiStore'
import { useVoiceStore } from '../../stores/voiceStore'
import { usePresenceStore, type PresenceStatus } from '../../stores/presenceStore'
import { useUnreadStore } from '../../stores/unreadStore'
import DmSidebar from '../dm/DmSidebar'
import VoiceControls from '../voice/VoiceControls'
import VoiceParticipants from '../voice/VoiceParticipants'
import ContextMenu, { type ContextMenuItem } from '../ui/ContextMenu'
import { useContextMenu } from '../../hooks/useContextMenu'
import ResizeHandle from './ResizeHandle'

const STATUS_COLORS: Record<PresenceStatus, string> = {
  online: 'bg-emerald-500',
  idle: 'bg-amber-500',
  dnd: 'bg-red-500',
  offline: 'bg-gray-500'
}

const STATUS_GLOW: Record<PresenceStatus, string> = {
  online: 'shadow-[0_0_6px_rgba(52,211,153,0.5)]',
  idle: 'shadow-[0_0_6px_rgba(251,191,36,0.5)]',
  dnd: 'shadow-[0_0_6px_rgba(248,113,113,0.5)]',
  offline: ''
}

type View = 'server' | 'dm'

export default function Sidebar(): React.JSX.Element {
  const servers = useServerStore((s) => s.servers)
  const activeServerId = useServerStore((s) => s.activeServerId)
  const activeChannelId = useServerStore((s) => s.activeChannelId)
  const setActiveServer = useServerStore((s) => s.setActiveServer)
  const setActiveChannel = useServerStore((s) => s.setActiveChannel)
  const deleteChannel = useServerStore((s) => s.deleteChannel)
  const openCreateServerModal = useUIStore((s) => s.openCreateServerModal)
  const openJoinServerModal = useUIStore((s) => s.openJoinServerModal)
  const openCreateChannelModal = useUIStore((s) => s.openCreateChannelModal)
  const openSettingsModal = useUIStore((s) => s.openSettingsModal)
  const openServerSettingsModal = useUIStore((s) => s.openServerSettingsModal)
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

  const currentView: View = !activeServerId ? 'dm' : 'server'
  const activeServer = servers.find((s) => s.id === activeServerId)

  const handleServerClick = (serverId: string): void => {
    selectConversation(null)
    setActiveServer(serverId)
  }

  const handleDmClick = (): void => {
    setActiveServer(null)
    setActiveChannel(null)
    fetchConversations()
  }

  const getServerItems = (serverId: string): ContextMenuItem[] => {
    const srv = servers.find((s) => s.id === serverId)
    const isOwner = srv?.owner_id === user?.id
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
    const srv = servers.find((s) => s.id === serverId)
    const isOwner = srv?.owner_id === user?.id
    return [
      ...(isOwner
        ? [
            {
              label: 'Delete Channel',
              icon: Trash2,
              onClick: () => deleteChannel(serverId, channelId),
              danger: true
            }
          ]
        : []),
      {
        label: 'Copy Channel ID',
        icon: Copy,
        onClick: () => navigator.clipboard.writeText(channelId),
        divider: isOwner
      }
    ]
  }

  // Compute total DM unreads
  const totalDmUnread = Object.values(dmUnreads).reduce((sum, n) => sum + n, 0)

  return (
    <div data-testid="sidebar" className="flex h-full">
      {/* Server rail */}
      <div className="w-[72px] bg-bg-base flex flex-col items-center py-3 gap-2">
        {/* DM button */}
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
            (sum, c) => sum + (channelUnreads[c.id] || 0),
            0
          )
          return (
            <div key={server.id} className="relative">
              {isActive && (
                <div className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1 w-1 h-8 bg-accent rounded-r-full" />
              )}
              <button
                onClick={() => handleServerClick(server.id)}
                onContextMenu={(e) => serverMenu.onContextMenu(e, server.id)}
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

      {/* Channel / DM list */}
      <div className="vesper-channel-sidebar-shell" style={{ width: `${channelSidebarWidth}px` }}>
        {currentView === 'dm' ? (
          <DmSidebarContent />
        ) : (
          <div className="vesper-channel-sidebar">
            {activeServer ? (
              <>
                <div className="vesper-channel-sidebar-header">
                  <div className="vesper-channel-sidebar-header-copy">
                    <span className="vesper-channel-sidebar-kicker">Server</span>
                    <h2 className="vesper-channel-sidebar-title">
                      {activeServer.name}
                    </h2>
                  </div>
                </div>

                <div className="vesper-channel-sidebar-scroller">
                  <div className="vesper-channel-group">
                    <div className="vesper-channel-group-header">
                      <span className="vesper-channel-group-label">Text Channels</span>
                      <button
                        onClick={openCreateChannelModal}
                        className="vesper-channel-group-action"
                        title="Create Channel"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="vesper-channel-group-list">
                      {activeServer.channels
                        .filter((c) => c.type === 'text')
                        .map((channel) => {
                          const unread = channelUnreads[channel.id] || 0
                          const isActive = channel.id === activeChannelId
                          return (
                            <button
                              key={channel.id}
                              onClick={() => setActiveChannel(channel.id)}
                              onContextMenu={(e) =>
                                channelMenu.onContextMenu(e, {
                                  channelId: channel.id,
                                  serverId: activeServer.id
                                })
                              }
                              className={`vesper-channel-row${isActive ? ' vesper-channel-row-active' : ''}${unread > 0 && !isActive ? ' vesper-channel-row-unread' : ''}`}
                            >
                              <span className="vesper-channel-row-icon">
                                <Hash className="w-4 h-4 shrink-0" />
                              </span>
                              <span className="vesper-channel-row-label">{channel.name}</span>
                              {unread > 0 && !isActive && (
                                <span className="vesper-channel-unread-badge">
                                  {unread > 99 ? '99+' : unread}
                                </span>
                              )}
                            </button>
                          )
                        })}
                    </div>
                  </div>

                  {activeServer.channels.some((c) => c.type === 'voice') && (
                    <div className="vesper-channel-group">
                      <div className="vesper-channel-group-header">
                        <span className="vesper-channel-group-label">Voice Channels</span>
                      </div>
                      <div className="vesper-channel-group-list">
                        {activeServer.channels
                          .filter((c) => c.type === 'voice')
                          .map((channel) => (
                            <div key={channel.id} className="vesper-channel-voice-block">
                              <button
                                onClick={() => useVoiceStore.getState().joinVoiceChannel(channel.id)}
                                className="vesper-channel-row vesper-channel-row-voice"
                              >
                                <span className="vesper-channel-row-icon">
                                  <Volume2 className="w-4 h-4 shrink-0" />
                                </span>
                                <span className="vesper-channel-row-label">{channel.name}</span>
                              </button>
                              <VoiceParticipants channelId={channel.id} />
                            </div>
                          ))}
                      </div>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-text-faintest text-sm px-4 text-center">
                Select or create a server
              </div>
            )}

            <VoiceControls />
            <UserBar user={user} logout={logout} openSettingsModal={openSettingsModal} />
          </div>
        )}
        <ResizeHandle
          side="right"
          onResizeDelta={(delta) => setChannelSidebarWidth(channelSidebarWidth + delta)}
        />
      </div>

      {/* Context menus */}
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

function DmSidebarContent(): React.JSX.Element {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const openSettingsModal = useUIStore((s) => s.openSettingsModal)

  return (
    <div className="vesper-channel-sidebar">
      <DmSidebar />
      <UserBar user={user} logout={logout} openSettingsModal={openSettingsModal} />
    </div>
  )
}

function UserBar({
  user,
  logout,
  openSettingsModal
}: {
  user: { id: string; username: string; display_name: string | null } | null
  logout: () => void
  openSettingsModal: () => void
}): React.JSX.Element {
  const myStatus = usePresenceStore((s) => s.myStatus)
  const setStatus = usePresenceStore((s) => s.setStatus)

  const cycleStatus = (): void => {
    const cycle: PresenceStatus[] = ['online', 'idle', 'dnd']
    const idx = cycle.indexOf(myStatus)
    setStatus(cycle[(idx + 1) % cycle.length])
  }

  return (
    <div className="px-3 py-2 bg-bg-base/50 border-t border-border flex items-center gap-2">
      <div className="relative w-8 h-8 shrink-0">
        <div className="w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center text-xs text-accent font-medium">
          {user?.username?.slice(0, 2).toUpperCase()}
        </div>
        <button
          onClick={cycleStatus}
          title={`Status: ${myStatus} (click to change)`}
          className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-bg-secondary ${STATUS_COLORS[myStatus]} ${STATUS_GLOW[myStatus]} cursor-pointer transition-all`}
        />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-text-primary text-sm truncate">{user?.display_name || user?.username}</p>
        {user?.display_name && (
          <p className="text-text-faint text-xs truncate">{user.username}</p>
        )}
      </div>
      <button
        onClick={openSettingsModal}
        className="text-text-faint hover:text-text-secondary transition-colors p-1 rounded hover:bg-bg-tertiary/50"
        title="Settings"
      >
        <Settings className="w-4 h-4" />
      </button>
      <button
        onClick={logout}
        className="text-text-faint hover:text-text-secondary transition-colors p-1 rounded hover:bg-bg-tertiary/50"
        title="Logout"
      >
        <LogOut className="w-4 h-4" />
      </button>
    </div>
  )
}
