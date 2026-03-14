import { useState, useEffect, useCallback } from 'react'
import {
  MessageCircle, Plus, ArrowRightToLine, Hash, Volume2, Settings, LogOut,
  Copy, Pencil, Trash2, Check, Link
} from 'lucide-react'
import { apiFetch } from '../../api/client'
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
      {currentView === 'dm' ? (
        <DmSidebarContent />
      ) : (
        <div className="w-56 min-w-0 bg-bg-secondary flex flex-col">
          {activeServer ? (
            <>
              <div className="px-4 py-3 border-b border-border">
                <div className="flex items-center gap-2">
                  <h2 className="text-text-primary font-semibold truncate flex-1 min-w-0">
                    {activeServer.name}
                  </h2>
                  <InviteCodeButton serverId={activeServer.id} />
                </div>
              </div>

              <div className="flex-1 overflow-y-auto py-2">
                <div className="flex items-center px-3 mb-1">
                  <span className="text-text-faint text-xs font-semibold uppercase tracking-wide flex-1">
                    Text Channels
                  </span>
                  <button
                    onClick={openCreateChannelModal}
                    className="text-text-faint hover:text-text-secondary transition-colors"
                    title="Create Channel"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>

                {activeServer.channels
                  .filter((c) => c.type === 'text')
                  .map((channel) => {
                    const unread = channelUnreads[channel.id] || 0
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
                        className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-1.5 transition-colors ${
                          channel.id === activeChannelId
                            ? 'bg-bg-tertiary/80 text-text-primary'
                            : 'text-text-muted hover:text-text-primary hover:bg-bg-tertiary/30'
                        }`}
                      >
                        <Hash className="w-4 h-4 text-text-faint shrink-0" />
                        <span
                          className={`truncate flex-1 ${
                            unread > 0 && channel.id !== activeChannelId
                              ? 'font-semibold text-text-primary'
                              : ''
                          }`}
                        >
                          {channel.name}
                        </span>
                        {unread > 0 && channel.id !== activeChannelId && (
                          <span className="min-w-[18px] h-[18px] bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1 shrink-0">
                            {unread > 99 ? '99+' : unread}
                          </span>
                        )}
                      </button>
                    )
                  })}

                {activeServer.channels.some((c) => c.type === 'voice') && (
                  <>
                    <div className="px-3 mt-3 mb-1">
                      <span className="text-text-faint text-xs font-semibold uppercase tracking-wide">
                        Voice Channels
                      </span>
                    </div>
                    {activeServer.channels
                      .filter((c) => c.type === 'voice')
                      .map((channel) => (
                        <div key={channel.id}>
                          <button
                            onClick={() => useVoiceStore.getState().joinVoiceChannel(channel.id)}
                            className="w-full text-left px-3 py-1.5 text-sm text-text-muted hover:text-text-primary hover:bg-bg-tertiary/30 flex items-center gap-1.5 transition-colors"
                          >
                            <Volume2 className="w-4 h-4 text-text-faint shrink-0" />
                            <span className="truncate">{channel.name}</span>
                          </button>
                          <VoiceParticipants channelId={channel.id} />
                        </div>
                      ))}
                  </>
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
    <div className="w-56 min-w-0 bg-bg-secondary flex flex-col">
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

function InviteCodeButton({ serverId }: { serverId: string }): React.JSX.Element | null {
  const [code, setCode] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(false)
  const [denied, setDenied] = useState(false)

  const fetchAndShow = async (): Promise<void> => {
    if (visible) {
      setVisible(false)
      setCode(null)
      return
    }
    setLoading(true)
    try {
      const res = await apiFetch(`/api/v1/servers/${serverId}/invite-code`)
      if (res.ok) {
        const data = await res.json()
        setCode(data.invite_code)
        setVisible(true)
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
    if (!code) return
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Reset state when server changes
  useEffect(() => {
    setCode(null)
    setVisible(false)
    setCopied(false)
    setDenied(false)
  }, [serverId])

  if (denied) return null

  return (
    <div className="flex items-center gap-1 shrink-0">
      {visible && code ? (
        <button
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
      ) : null}
      <button
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
