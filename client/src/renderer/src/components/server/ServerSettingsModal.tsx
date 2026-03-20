import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Copy, History, ImagePlus, Link, Pencil, Settings, Shield, Smile, Trash2, Upload, UserX, Users, X } from 'lucide-react'
import { useServerStore, type AuditLogEntry, type Member, type ServerBan } from '../../stores/serverStore'
import { useAuthStore } from '../../stores/authStore'
import { useUIStore } from '../../stores/uiStore'
import RoleManager from './RoleManager'
import InviteManager from './InviteManager'
import EmojiUploadModal from './EmojiUploadModal'
import ImageCropModal from '../ui/ImageCropModal'
import SettingsShell, { type SettingsSectionGroup } from '../settings/SettingsShell'

const EMPTY_BANS: ServerBan[] = []
const EMPTY_AUDIT_ENTRIES: AuditLogEntry[] = []

type ServerSettingsSection =
  | 'general'
  | 'members'
  | 'roles'
  | 'invites'
  | 'emojis'
  | 'moderation'
  | 'audit'
  | 'danger'

export default function ServerSettingsModal(): React.JSX.Element | null {
  const closeServerSettingsModal = useUIStore((s) => s.closeServerSettingsModal)
  const activeServerId = useServerStore((s) => s.activeServerId)
  const servers = useServerStore((s) => s.servers)
  const members = useServerStore((s) => s.members)
  const bans = useServerStore((s) =>
    activeServerId ? (s.bansByServer[activeServerId] ?? EMPTY_BANS) : EMPTY_BANS
  )
  const auditEntries = useServerStore((s) =>
    activeServerId
      ? (s.auditLogByServer[activeServerId] ?? EMPTY_AUDIT_ENTRIES)
      : EMPTY_AUDIT_ENTRIES
  )
  const fetchMembers = useServerStore((s) => s.fetchMembers)
  const updateServer = useServerStore((s) => s.updateServer)
  const changeMemberRole = useServerStore((s) => s.changeMemberRole)
  const kickMember = useServerStore((s) => s.kickMember)
  const fetchBans = useServerStore((s) => s.fetchBans)
  const banMember = useServerStore((s) => s.banMember)
  const unbanMember = useServerStore((s) => s.unbanMember)
  const fetchAuditLog = useServerStore((s) => s.fetchAuditLog)
  const deleteServer = useServerStore((s) => s.deleteServer)
  const uploadServerIcon = useServerStore((s) => s.uploadServerIcon)
  const fetchServerEmojis = useServerStore((s) => s.fetchServerEmojis)
  const renameServerEmoji = useServerStore((s) => s.renameServerEmoji)
  const deleteServerEmoji = useServerStore((s) => s.deleteServerEmoji)
  const myId = useAuthStore((s) => s.user?.id)

  const server = servers.find((entry) => entry.id === activeServerId)
  const isOwner = server?.owner_id === myId
  const myMembership = members.find((member) => member.user_id === myId)
  const canModerateMembers = Boolean(isOwner || myMembership?.role === 'admin')
  const canManageEmojis = Boolean(isOwner || myMembership?.role === 'admin')

  const [activeSection, setActiveSection] = useState<ServerSettingsSection>('general')
  const [serverName, setServerName] = useState(server?.name || '')
  const [saving, setSaving] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [emojiActionPending, setEmojiActionPending] = useState(false)
  const [emojiFeedback, setEmojiFeedback] = useState<string | null>(null)
  const [emojiError, setEmojiError] = useState<string | null>(null)
  const [emojiUploadFile, setEmojiUploadFile] = useState<File | null>(null)
  const [iconCropFile, setIconCropFile] = useState<File | null>(null)
  const [renamingEmojiId, setRenamingEmojiId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [banReason, setBanReason] = useState('')
  const [pendingBanUserId, setPendingBanUserId] = useState<string | null>(null)
  const [pendingUnbanUserId, setPendingUnbanUserId] = useState<string | null>(null)
  const [auditLoading, setAuditLoading] = useState(false)
  const iconFileInputRef = useRef<HTMLInputElement>(null)
  const emojiFileInputRef = useRef<HTMLInputElement>(null)

  const sections: SettingsSectionGroup[] = [
    {
      title: 'Server Settings',
      items: [
        { id: 'general', label: 'Overview', icon: Settings },
        { id: 'members', label: 'Members', icon: Users },
        { id: 'roles', label: 'Roles', icon: Shield },
        { id: 'invites', label: 'Invites', icon: Link, testId: 'invites-tab' },
        { id: 'emojis', label: 'Emoji', icon: Smile, testId: 'emoji-tab' },
        { id: 'moderation', label: 'Moderation', icon: UserX },
        { id: 'audit', label: 'Audit Log', icon: History },
        ...(isOwner ? [{ id: 'danger', label: 'Danger Zone', tone: 'danger' as const, icon: AlertTriangle }] : [])
      ]
    }
  ]

  useEffect(() => {
    setServerName(server?.name || '')
  }, [server?.id, server?.name])

  useEffect(() => {
    if (!activeServerId) {
      return
    }

    void fetchMembers(activeServerId)
  }, [activeServerId, fetchMembers])

  useEffect(() => {
    if (activeServerId && activeSection === 'emojis') {
      void fetchServerEmojis(activeServerId)
    }
  }, [activeSection, activeServerId, fetchServerEmojis])

  useEffect(() => {
    if (activeServerId && activeSection === 'moderation') {
      void fetchBans(activeServerId)
    }
  }, [activeSection, activeServerId, fetchBans])

  useEffect(() => {
    if (activeServerId && activeSection === 'audit') {
      setAuditLoading(true)
      void fetchAuditLog(activeServerId).finally(() => setAuditLoading(false))
    }
  }, [activeSection, activeServerId, fetchAuditLog])

  if (!server || !activeServerId) {
    return null
  }

  const handleSaveName = async (): Promise<void> => {
    const trimmed = serverName.trim()
    if (!trimmed || trimmed === server.name) {
      return
    }

    setSaving(true)
    await updateServer(activeServerId, { name: trimmed })
    setSaving(false)
  }

  const handleDeleteServer = async (): Promise<void> => {
    if (deleteConfirm !== server.name) {
      return
    }

    await deleteServer(activeServerId)
    closeServerSettingsModal()
  }

  const handleCopy = (value: string): void => {
    navigator.clipboard.writeText(value)
  }

  const handleEmojiFileSelect = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    if (file) {
      setEmojiUploadFile(file)
    }
    event.target.value = ''
  }

  const handleEmojiDelete = async (emojiId: string, emojiNameValue: string): Promise<void> => {
    setEmojiActionPending(true)
    setEmojiFeedback(null)
    setEmojiError(null)

    const ok = await deleteServerEmoji(activeServerId, emojiId)
    if (ok) {
      setEmojiFeedback(`Deleted :${emojiNameValue}:`)
    } else {
      setEmojiError('Could not delete emoji. Check permissions and try again.')
    }

    setEmojiActionPending(false)
  }

  const handleEmojiRename = async (emojiId: string): Promise<void> => {
    if (!renameValue.trim() || !/^[a-zA-Z0-9_~-]{2,32}$/.test(renameValue)) {
      setRenamingEmojiId(null)
      return
    }

    setEmojiActionPending(true)
    setEmojiFeedback(null)
    setEmojiError(null)

    const result = await renameServerEmoji(activeServerId, emojiId, renameValue.trim())
    if (result) {
      setEmojiFeedback(`Renamed to :${result.name}:`)
    } else {
      setEmojiError('Could not rename emoji.')
    }

    setRenamingEmojiId(null)
    setEmojiActionPending(false)
  }

  const handleBan = async (userId: string): Promise<void> => {
    setPendingBanUserId(userId)
    const ok = await banMember(activeServerId, userId, banReason)
    if (ok) {
      setBanReason('')
      await fetchMembers(activeServerId)
      await fetchBans(activeServerId)
    }
    setPendingBanUserId(null)
  }

  const handleUnban = async (userId: string): Promise<void> => {
    setPendingUnbanUserId(userId)
    const ok = await unbanMember(activeServerId, userId)
    if (ok) {
      await fetchBans(activeServerId)
    }
    setPendingUnbanUserId(null)
  }

  return (
    <SettingsShell
      testId="server-settings"
      title="Server Settings"
      activeSection={activeSection}
      sections={sections}
      onSectionChange={(sectionId) => setActiveSection(sectionId as ServerSettingsSection)}
      onClose={closeServerSettingsModal}
    >
      {activeSection === 'general' && (
        <>
          <div className="vesper-settings-page-header">
            <div>
              <h1 className="vesper-settings-page-title">Overview</h1>
              <p className="vesper-settings-page-description">Adjust the basics for this server.</p>
            </div>
          </div>

          <div className="vesper-settings-card">
            <div className="vesper-settings-server-hero">
              <div className="relative group">
                {server.icon_url ? (
                  <img
                    src={server.icon_url}
                    alt={server.name}
                    className="w-16 h-16 rounded-full object-cover"
                  />
                ) : (
                  <div className="vesper-settings-server-glyph">
                    {server.name.slice(0, 2).toUpperCase()}
                  </div>
                )}
                {(isOwner || myMembership?.role === 'admin') && (
                  <button
                    type="button"
                    onClick={() => iconFileInputRef.current?.click()}
                    className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Change server icon"
                  >
                    <ImagePlus className="w-5 h-5 text-white" />
                  </button>
                )}
                <input
                  ref={iconFileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) setIconCropFile(file)
                    event.target.value = ''
                  }}
                />
              </div>
              <div>
                <div className="vesper-settings-profile-name">{server.name}</div>
                <div className="vesper-settings-profile-note">{members.length} members in this server</div>
              </div>
            </div>

            <div className="vesper-settings-form-grid">
              <label className="vesper-settings-field">
                <span className="vesper-settings-label">Server Name</span>
                <input
                  type="text"
                  value={serverName}
                  onChange={(event) => setServerName(event.target.value)}
                  className="vesper-settings-input"
                />
              </label>

              <label className="vesper-settings-field">
                <span className="vesper-settings-label">Server ID</span>
                <div className="vesper-settings-inline-row">
                  <input
                    type="text"
                    value={server.id}
                    readOnly
                    className="vesper-settings-input vesper-settings-input-disabled"
                  />
                  <button
                    type="button"
                    onClick={() => handleCopy(server.id)}
                    className="vesper-settings-icon-button"
                    title="Copy server ID"
                  >
                    <Copy className="w-4 h-4" />
                  </button>
                </div>
              </label>
            </div>

            <div className="vesper-settings-card-actions">
              <button
                type="button"
                onClick={handleSaveName}
                disabled={saving || !serverName.trim() || serverName.trim() === server.name}
                className="vesper-settings-primary-button"
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>

          {iconCropFile && (
            <ImageCropModal
              file={iconCropFile}
              title="Server Icon"
              cropShape="round"
              aspect={1}
              outputSize={{ width: 256, height: 256 }}
              onSubmit={async (blob) => {
                const croppedFile = new File([blob], 'icon.png', { type: 'image/png' })
                await uploadServerIcon(activeServerId, croppedFile)
                setIconCropFile(null)
              }}
              onClose={() => setIconCropFile(null)}
            />
          )}
        </>
      )}

      {activeSection === 'members' && (
        <>
          <div className="vesper-settings-page-header">
            <div>
              <h1 className="vesper-settings-page-title">Members</h1>
              <p className="vesper-settings-page-description">Review who is here and manage their roles.</p>
            </div>
          </div>

          <div className="vesper-settings-card">
            {canModerateMembers && (
              <label className="vesper-settings-field">
                <span className="vesper-settings-label">Default Ban Reason</span>
                <input
                  type="text"
                  value={banReason}
                  onChange={(event) => setBanReason(event.target.value)}
                  placeholder="Optional note saved with each ban"
                  className="vesper-settings-input"
                />
              </label>
            )}
            <div className="vesper-settings-member-list">
              {members.map((member) => {
                const targetIsOwner = server.owner_id === member.user_id
                return (
                  <MemberSettingsRow
                    key={member.id}
                    member={member}
                    targetIsOwner={targetIsOwner}
                    canManage={Boolean(isOwner && !targetIsOwner)}
                    canBan={Boolean(canModerateMembers && !targetIsOwner && member.user_id !== myId)}
                    banPending={pendingBanUserId === member.user_id}
                    onRoleChange={(role) => changeMemberRole(activeServerId, member.user_id, role)}
                    onKick={() => kickMember(activeServerId, member.user_id)}
                    onBan={() => {
                      void handleBan(member.user_id)
                    }}
                  />
                )
              })}
            </div>
          </div>
        </>
      )}

      {activeSection === 'roles' && (
        <>
          <div className="vesper-settings-page-header">
            <div>
              <h1 className="vesper-settings-page-title">Roles</h1>
              <p className="vesper-settings-page-description">Manage access and presentation inside this server.</p>
            </div>
          </div>
          <div className="vesper-settings-card">
            <RoleManager embedded />
          </div>
        </>
      )}

      {activeSection === 'invites' && (
        <>
          <div className="vesper-settings-page-header">
            <div>
              <h1 className="vesper-settings-page-title">Invites</h1>
              <p className="vesper-settings-page-description">Create new invites and manage existing ones.</p>
            </div>
          </div>
          <div className="vesper-settings-card">
            <InviteManager />
          </div>
        </>
      )}

      {activeSection === 'emojis' && (
        <>
          <div className="vesper-settings-page-header">
            <div>
              <h1 className="vesper-settings-page-title">Emoji</h1>
              <p className="vesper-settings-page-description">Upload and manage custom emoji for this server.</p>
            </div>
          </div>

          <div className="vesper-settings-card">
            {canManageEmojis && (
              <div className="mb-4">
                <button
                  data-testid="emoji-save"
                  type="button"
                  onClick={() => emojiFileInputRef.current?.click()}
                  className="px-4 py-2 glow-accent hover:glow-accent-hover text-bg-base rounded-lg text-sm font-medium transition-all inline-flex items-center gap-2"
                >
                  <Upload className="w-4 h-4" />
                  Upload Emoji
                </button>
                <input
                  data-testid="emoji-upload"
                  ref={emojiFileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  className="hidden"
                  onChange={handleEmojiFileSelect}
                />
              </div>
            )}

            {emojiFeedback && (
              <div className="vesper-settings-feedback vesper-settings-feedback-success">{emojiFeedback}</div>
            )}
            {emojiError && (
              <div className="vesper-settings-feedback vesper-settings-feedback-error">{emojiError}</div>
            )}

            <div data-testid="custom-emoji-list">
              {server.emojis.length === 0 ? (
                <div className="vesper-settings-note-pill">No custom emoji uploaded yet.</div>
              ) : (
                <>
                  <div className="text-sm text-text-faint mb-2">
                    {server.emojis.length} emoji{server.emojis.length !== 1 ? 's' : ''}
                  </div>

                  {/* Table header */}
                  <div className="grid grid-cols-[3rem_1fr_1fr_auto] gap-3 items-center px-3 py-2 text-xs text-text-faint uppercase tracking-wider border-b border-border">
                    <span>Image</span>
                    <span>Name</span>
                    <span>Uploaded By</span>
                    <span className="w-16" />
                  </div>

                  {/* Rows */}
                  {server.emojis.map((emoji) => (
                    <div
                      key={emoji.id}
                      className="group grid grid-cols-[3rem_1fr_1fr_auto] gap-3 items-center px-3 py-2.5 border-b border-border/50 hover:bg-bg-surface/50 transition-colors"
                    >
                      {/* Image */}
                      <img
                        src={emoji.url}
                        alt={`:${emoji.name}:`}
                        className="w-10 h-10 object-contain rounded"
                      />

                      {/* Name */}
                      <div className="min-w-0">
                        {renamingEmojiId === emoji.id ? (
                          <form
                            className="flex items-center gap-2"
                            onSubmit={(e) => {
                              e.preventDefault()
                              void handleEmojiRename(emoji.id)
                            }}
                          >
                            <input
                              type="text"
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              className="rounded bg-bg-base/50 border border-border text-text-primary px-2 py-1 text-sm input-focus w-40"
                              maxLength={32}
                              autoFocus
                              onBlur={() => { void handleEmojiRename(emoji.id) }}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') {
                                  setRenamingEmojiId(null)
                                }
                              }}
                            />
                            <button
                              type="submit"
                              className="text-green-400 hover:text-green-300"
                              title="Save"
                            >
                              <Check className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setRenamingEmojiId(null)}
                              className="text-text-muted hover:text-text-primary"
                              title="Cancel"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </form>
                        ) : (
                          <span className="text-sm text-text-primary font-mono bg-bg-base/40 px-1.5 py-0.5 rounded">
                            :{emoji.name}:
                          </span>
                        )}
                      </div>

                      {/* Uploaded By */}
                      <div className="flex items-center gap-2 min-w-0">
                        {emoji.creator ? (
                          <>
                            {emoji.creator.avatar_url ? (
                              <img
                                src={emoji.creator.avatar_url}
                                alt=""
                                className="w-5 h-5 rounded-full shrink-0"
                              />
                            ) : (
                              <div className="w-5 h-5 rounded-full bg-bg-surface shrink-0" />
                            )}
                            <span className="text-sm text-text-secondary truncate">
                              {emoji.creator.display_name || emoji.creator.username}
                            </span>
                          </>
                        ) : (
                          <span className="text-sm text-text-faint">Unknown</span>
                        )}
                      </div>

                      {/* Actions (visible on hover) */}
                      <div className="flex items-center gap-1 w-16 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                        {canManageEmojis && (
                          <>
                            <button
                              type="button"
                              className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-surface transition-colors"
                              disabled={emojiActionPending}
                              onClick={() => {
                                setRenamingEmojiId(emoji.id)
                                setRenameValue(emoji.name)
                              }}
                              title="Rename emoji"
                            >
                              <Pencil className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              className="p-1.5 rounded text-text-muted hover:text-red-400 hover:bg-red-400/10 transition-colors"
                              disabled={emojiActionPending}
                              onClick={() => {
                                void handleEmojiDelete(emoji.id, emoji.name)
                              }}
                              title="Delete emoji"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>

          {emojiUploadFile && server && (
            <EmojiUploadModal
              file={emojiUploadFile}
              serverId={server.id}
              onClose={() => setEmojiUploadFile(null)}
            />
          )}
        </>
      )}

      {activeSection === 'moderation' && (
        <>
          <div className="vesper-settings-page-header">
            <div>
              <h1 className="vesper-settings-page-title">Moderation</h1>
              <p className="vesper-settings-page-description">Review server bans and restore access when needed.</p>
            </div>
          </div>

          <div className="vesper-settings-card">
            <div className="vesper-settings-ban-list">
              {bans.length === 0 ? (
                <div className="vesper-settings-note-pill">No users are currently banned.</div>
              ) : (
                bans.map((ban) => (
                  <BanRow
                    key={`${ban.server_id}:${ban.user_id}`}
                    ban={ban}
                    canManage={canModerateMembers}
                    pending={pendingUnbanUserId === ban.user_id}
                    onUnban={() => {
                      void handleUnban(ban.user_id)
                    }}
                  />
                ))
              )}
            </div>
          </div>
        </>
      )}

      {activeSection === 'audit' && (
        <>
          <div className="vesper-settings-page-header">
            <div>
              <h1 className="vesper-settings-page-title">Audit Log</h1>
              <p className="vesper-settings-page-description">Track moderation and administrative actions.</p>
            </div>
          </div>

          <div className="vesper-settings-card">
            {auditLoading ? (
              <div className="vesper-settings-note-pill">Loading audit entries...</div>
            ) : (
              <div className="vesper-settings-audit-list">
                {auditEntries.length === 0 ? (
                  <div className="vesper-settings-note-pill">No audit entries yet.</div>
                ) : (
                  auditEntries.map((entry) => (
                    <AuditRow key={entry.id} entry={entry} />
                  ))
                )}
              </div>
            )}
          </div>
        </>
      )}

      {activeSection === 'danger' && isOwner && (
        <>
          <div className="vesper-settings-page-header">
            <div>
              <h1 className="vesper-settings-page-title">Danger Zone</h1>
              <p className="vesper-settings-page-description">Permanent actions live here.</p>
            </div>
          </div>

          <div className="vesper-settings-card vesper-settings-card-danger">
            <div className="vesper-settings-danger-header">
              <AlertTriangle className="w-4 h-4" />
              <span>Delete Server</span>
            </div>
            <p className="vesper-settings-row-copy">
              This removes every channel, message, invite, and member relationship in this server.
            </p>
            <label className="vesper-settings-field">
              <span className="vesper-settings-label">Type {server.name} to confirm</span>
              <input
                type="text"
                value={deleteConfirm}
                onChange={(event) => setDeleteConfirm(event.target.value)}
                placeholder={server.name}
                className="vesper-settings-input"
              />
            </label>
            <div className="vesper-settings-card-actions">
              <button
                type="button"
                onClick={handleDeleteServer}
                disabled={deleteConfirm !== server.name}
                className="vesper-settings-danger-button"
              >
                <Trash2 className="w-4 h-4" />
                Delete Server
              </button>
            </div>
          </div>
        </>
      )}
    </SettingsShell>
  )
}

function MemberSettingsRow({
  member,
  targetIsOwner,
  canManage,
  canBan,
  banPending,
  onRoleChange,
  onKick,
  onBan
}: {
  member: Member
  targetIsOwner: boolean
  canManage: boolean
  canBan: boolean
  banPending: boolean
  onRoleChange: (role: string) => void
  onKick: () => void
  onBan: () => void
}): React.JSX.Element {
  const displayName = member.user?.display_name || member.user?.username || 'Unknown'

  return (
    <div className="vesper-settings-member-row">
      <div className="vesper-settings-member-avatar">
        {displayName.slice(0, 2).toUpperCase()}
      </div>
      <div className="vesper-settings-member-copy">
        <div className="vesper-settings-member-name">{displayName}</div>
        <div className="vesper-settings-member-meta">@{member.user.username}</div>
      </div>

      {targetIsOwner ? (
        <div className="vesper-settings-note-pill">
          <Shield className="w-4 h-4" />
          <span>Owner</span>
        </div>
      ) : canManage ? (
        <div className="vesper-settings-member-actions">
          <select
            value={member.role}
            onChange={(event) => onRoleChange(event.target.value)}
            className="vesper-settings-select"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <button
            type="button"
            onClick={onKick}
            className="vesper-settings-icon-button vesper-settings-icon-button-danger"
            title="Kick member"
          >
            <Users className="w-4 h-4" />
          </button>
          {canBan && (
            <button
              type="button"
              onClick={onBan}
              disabled={banPending}
              className="vesper-settings-icon-button vesper-settings-icon-button-danger"
              title="Ban member"
            >
              <UserX className="w-4 h-4" />
            </button>
          )}
        </div>
      ) : (
        <div className="vesper-settings-note-pill">
          <Link className="w-4 h-4" />
          <span>{member.role}</span>
        </div>
      )}
    </div>
  )
}

function BanRow({
  ban,
  canManage,
  pending,
  onUnban
}: {
  ban: ServerBan
  canManage: boolean
  pending: boolean
  onUnban: () => void
}): React.JSX.Element {
  const displayName = ban.user?.display_name || ban.user?.username || ban.user_id

  return (
    <div className="vesper-settings-ban-row">
      <div className="vesper-settings-member-avatar">
        {displayName.slice(0, 2).toUpperCase()}
      </div>
      <div className="vesper-settings-member-copy">
        <div className="vesper-settings-member-name">{displayName}</div>
        <div className="vesper-settings-member-meta">User ID: {ban.user_id}</div>
        {ban.reason && (
          <div className="vesper-settings-member-meta">Reason: {ban.reason}</div>
        )}
      </div>

      <div className="vesper-settings-ban-meta">
        <span>Banned {formatRelativeTime(ban.inserted_at)}</span>
        {canManage && (
          <button
            type="button"
            onClick={onUnban}
            disabled={pending}
            className="vesper-settings-secondary-button"
          >
            Unban
          </button>
        )}
      </div>
    </div>
  )
}

function AuditRow({ entry }: { entry: AuditLogEntry }): React.JSX.Element {
  const actorName = entry.actor?.display_name || entry.actor?.username || entry.actor_id || 'System'
  const targetLabel = entry.target_user_id || entry.target_id || 'n/a'

  return (
    <div className="vesper-settings-audit-row">
      <div className="vesper-settings-audit-head">
        <span className="vesper-settings-audit-action">{entry.action}</span>
        <span className="vesper-settings-audit-time">{formatRelativeTime(entry.inserted_at)}</span>
      </div>
      <div className="vesper-settings-audit-copy">
        <span>Actor: {actorName}</span>
        <span>Target: {targetLabel}</span>
      </div>
      {entry.metadata && Object.keys(entry.metadata).length > 0 && (
        <pre className="vesper-settings-audit-meta">
          {JSON.stringify(entry.metadata, null, 2)}
        </pre>
      )}
    </div>
  )
}

function formatRelativeTime(iso: string): string {
  const timestamp = new Date(iso).getTime()
  const deltaMs = Date.now() - timestamp
  const deltaSeconds = Math.max(0, Math.floor(deltaMs / 1000))
  const deltaMinutes = Math.floor(deltaSeconds / 60)
  const deltaHours = Math.floor(deltaMinutes / 60)
  const deltaDays = Math.floor(deltaHours / 24)

  if (deltaMinutes < 1) return 'just now'
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`
  if (deltaHours < 24) return `${deltaHours}h ago`
  if (deltaDays < 7) return `${deltaDays}d ago`

  return new Date(iso).toLocaleDateString()
}
