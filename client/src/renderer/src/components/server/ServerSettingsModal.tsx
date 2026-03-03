import { useState } from 'react'
import { Settings, Users, Shield, AlertTriangle, Crown, Copy, Trash2, UserMinus, Link } from 'lucide-react'
import { useServerStore, type Member } from '../../stores/serverStore'
import { useAuthStore } from '../../stores/authStore'
import { useUIStore } from '../../stores/uiStore'
import RoleManager from './RoleManager'
import InviteManager from './InviteManager'

type Tab = 'general' | 'members' | 'roles' | 'invites' | 'danger'

export default function ServerSettingsModal(): React.JSX.Element | null {
  const closeServerSettingsModal = useUIStore((s) => s.closeServerSettingsModal)
  const activeServerId = useServerStore((s) => s.activeServerId)
  const servers = useServerStore((s) => s.servers)
  const members = useServerStore((s) => s.members)
  const updateServer = useServerStore((s) => s.updateServer)
  const changeMemberRole = useServerStore((s) => s.changeMemberRole)
  const kickMember = useServerStore((s) => s.kickMember)
  const deleteServer = useServerStore((s) => s.deleteServer)
  const myId = useAuthStore((s) => s.user?.id)

  const server = servers.find((s) => s.id === activeServerId)
  const isOwner = server?.owner_id === myId

  const [activeTab, setActiveTab] = useState<Tab>('general')
  const [serverName, setServerName] = useState(server?.name || '')
  const [saving, setSaving] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState('')

  if (!server || !activeServerId) return null

  const handleSaveName = async (): Promise<void> => {
    const trimmed = serverName.trim()
    if (!trimmed || trimmed === server.name) return
    setSaving(true)
    await updateServer(activeServerId, { name: trimmed })
    setSaving(false)
  }

  const handleDeleteServer = async (): Promise<void> => {
    if (deleteConfirm !== server.name) return
    await deleteServer(activeServerId)
    closeServerSettingsModal()
  }

  const handleCopy = (text: string): void => {
    navigator.clipboard.writeText(text)
  }

  const tabs: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }>; ownerOnly?: boolean }[] = [
    { id: 'general', label: 'General', icon: Settings },
    { id: 'members', label: 'Members', icon: Users },
    { id: 'roles', label: 'Roles', icon: Shield },
    { id: 'invites', label: 'Invites', icon: Link },
    { id: 'danger', label: 'Danger Zone', icon: AlertTriangle, ownerOnly: true }
  ]

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="glass-card rounded-2xl w-[700px] max-w-[calc(100vw-2rem)] max-h-[80vh] flex flex-col animate-scale-in">
        {/* Header */}
        <div className="px-6 py-4 border-b border-border flex items-center justify-between shrink-0">
          <h2 className="text-lg font-semibold text-text-primary">Server Settings</h2>
          <button
            onClick={closeServerSettingsModal}
            className="text-text-faint hover:text-text-primary text-sm transition-colors"
          >
            Close
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Tab sidebar */}
          <div className="w-44 border-r border-border py-3 px-2 shrink-0">
            {tabs
              .filter((t) => !t.ownerOnly || isOwner)
              .map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full text-left px-3 py-2 text-sm rounded-lg flex items-center gap-2 transition-colors ${
                    activeTab === tab.id
                      ? 'bg-bg-tertiary text-text-primary'
                      : 'text-text-muted hover:text-text-primary hover:bg-bg-tertiary/30'
                  }`}
                >
                  <tab.icon className="w-4 h-4" />
                  {tab.label}
                </button>
              ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto p-6">
            {activeTab === 'general' && (
              <div className="space-y-4">
                <div>
                  <label className="block text-text-muted text-xs mb-1">Server Name</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={serverName}
                      onChange={(e) => setServerName(e.target.value)}
                      className="flex-1 bg-bg-base/50 text-text-primary px-3 py-2 rounded-lg border border-border input-focus text-sm"
                      onKeyDown={(e) => e.key === 'Enter' && handleSaveName()}
                    />
                    <button
                      onClick={handleSaveName}
                      disabled={saving || !serverName.trim() || serverName.trim() === server.name}
                      className="px-3 py-2 glow-accent hover:glow-accent-hover disabled:opacity-40 disabled:shadow-none text-bg-base rounded-lg text-sm font-medium transition-all"
                    >
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-text-muted text-xs mb-1">Server ID</label>
                  <div className="flex items-center gap-2">
                    <span className="bg-bg-base/50 text-text-secondary px-3 py-2 rounded-lg border border-border text-sm font-mono flex-1 truncate">
                      {server.id}
                    </span>
                    <button
                      onClick={() => handleCopy(server.id)}
                      className="p-2 text-text-faint hover:text-text-primary transition-colors rounded-lg hover:bg-bg-tertiary/50"
                      title="Copy"
                    >
                      <Copy className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'members' && (
              <div className="space-y-1">
                {members.map((member) => {
                  const targetIsOwner = server.owner_id === member.user_id
                  const displayName = member.user?.display_name || member.user?.username || 'Unknown'
                  return (
                    <div
                      key={member.id}
                      className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-bg-tertiary/30 transition-colors"
                    >
                      <div className="w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center text-xs text-accent font-medium shrink-0">
                        {displayName.slice(0, 2).toUpperCase()}
                      </div>
                      <span className="text-sm text-text-primary flex-1 truncate">{displayName}</span>
                      {targetIsOwner && <Crown className="w-4 h-4 text-amber-400 shrink-0" />}
                      {isOwner && !targetIsOwner && (
                        <>
                          <select
                            value={member.role}
                            onChange={(e) => changeMemberRole(activeServerId, member.user_id, e.target.value)}
                            className="bg-bg-base/50 text-text-secondary text-xs px-2 py-1 rounded border border-border"
                          >
                            <option value="member">Member</option>
                            <option value="admin">Admin</option>
                          </select>
                          <button
                            onClick={() => kickMember(activeServerId, member.user_id)}
                            className="p-1.5 text-text-faint hover:text-red-400 transition-colors rounded hover:bg-bg-tertiary/50"
                            title="Kick"
                          >
                            <UserMinus className="w-4 h-4" />
                          </button>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {activeTab === 'roles' && (
              <RoleManager embedded />
            )}

            {activeTab === 'invites' && (
              <InviteManager />
            )}

            {activeTab === 'danger' && isOwner && (
              <div className="space-y-4">
                <div className="border border-red-500/30 rounded-xl p-4 bg-red-500/5">
                  <h3 className="text-red-400 font-semibold text-sm mb-2 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4" />
                    Delete Server
                  </h3>
                  <p className="text-text-muted text-xs mb-3">
                    This action is permanent and cannot be undone. All channels, messages, and members will be removed.
                  </p>
                  <label className="block text-text-muted text-xs mb-1">
                    Type <span className="text-text-primary font-mono">{server.name}</span> to confirm
                  </label>
                  <input
                    type="text"
                    value={deleteConfirm}
                    onChange={(e) => setDeleteConfirm(e.target.value)}
                    placeholder={server.name}
                    className="w-full bg-bg-base/50 text-text-primary px-3 py-2 rounded-lg border border-red-500/30 input-focus text-sm mb-3"
                  />
                  <button
                    onClick={handleDeleteServer}
                    disabled={deleteConfirm !== server.name}
                    className="px-4 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete Server
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
