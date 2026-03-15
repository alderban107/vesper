import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Copy,
  Folder,
  Hash,
  Lock,
  Settings,
  Timer,
  Trash2,
  Volume2
} from 'lucide-react'
import {
  type Channel,
  type ChannelPermissionOverride,
  type PermissionOverrideUpsertInput,
  useServerStore
} from '../../stores/serverStore'
import { useAuthStore } from '../../stores/authStore'
import { useUIStore } from '../../stores/uiStore'
import SettingsShell, { type SettingsSectionGroup } from '../settings/SettingsShell'

type ChannelSettingsSection = 'overview' | 'behavior' | 'permissions' | 'danger'
type PermissionDecision = 'inherit' | 'allow' | 'deny'

const TTL_OPTIONS: Array<{ label: string; value: number | null }> = [
  { label: 'Off', value: null },
  { label: '1 hour', value: 3600 },
  { label: '24 hours', value: 86400 },
  { label: '7 days', value: 604800 },
  { label: '30 days', value: 2592000 }
]

function sortChannels(channels: Channel[]): Channel[] {
  return [...channels].sort(
    (left, right) => left.position - right.position || left.name.localeCompare(right.name)
  )
}

function getChannelIcon(channel: Channel): React.JSX.Element {
  if (channel.type === 'voice') {
    return <Volume2 className="w-4 h-4" />
  }

  if (channel.type === 'category') {
    return <Folder className="w-4 h-4" />
  }

  return <Hash className="w-4 h-4" />
}

function getPermissionDecision(allow: boolean, deny: boolean): PermissionDecision {
  if (allow) return 'allow'
  if (deny) return 'deny'
  return 'inherit'
}

export default function ChannelSettingsModal(): React.JSX.Element | null {
  const closeChannelSettingsModal = useUIStore((s) => s.closeChannelSettingsModal)
  const channelSettingsChannelId = useUIStore((s) => s.channelSettingsChannelId)
  const activeServerId = useServerStore((s) => s.activeServerId)
  const servers = useServerStore((s) => s.servers)
  const members = useServerStore((s) => s.members)
  const roles = useServerStore((s) =>
    activeServerId ? (s.rolesByServer[activeServerId] ?? []) : []
  )
  const permissionOverrides = useServerStore((s) =>
    channelSettingsChannelId ? (s.channelPermissionOverrides[channelSettingsChannelId] ?? []) : []
  )
  const fetchMembers = useServerStore((s) => s.fetchMembers)
  const fetchRoles = useServerStore((s) => s.fetchRoles)
  const fetchChannelPermissionOverrides = useServerStore((s) => s.fetchChannelPermissionOverrides)
  const saveChannelPermissionOverride = useServerStore((s) => s.saveChannelPermissionOverride)
  const deleteChannelPermissionOverride = useServerStore((s) => s.deleteChannelPermissionOverride)
  const updateChannel = useServerStore((s) => s.updateChannel)
  const deleteChannel = useServerStore((s) => s.deleteChannel)
  const userId = useAuthStore((s) => s.user?.id)

  const server = servers.find((entry) => entry.id === activeServerId)
  const channel = server?.channels.find((entry) => entry.id === channelSettingsChannelId)
  const isOwner = server?.owner_id === userId
  const isCategory = channel?.type === 'category'

  const [activeSection, setActiveSection] = useState<ChannelSettingsSection>('overview')
  const [name, setName] = useState(channel?.name ?? '')
  const [topic, setTopic] = useState(channel?.topic ?? '')
  const [categoryId, setCategoryId] = useState(channel?.category_id ?? '')
  const [ttl, setTtl] = useState<number | null>(channel?.disappearing_ttl ?? null)
  const [saving, setSaving] = useState(false)
  const [permissionsSavingKey, setPermissionsSavingKey] = useState<string | null>(null)
  const [targetType, setTargetType] = useState<'role' | 'user'>('role')
  const [targetId, setTargetId] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState('')

  useEffect(() => {
    setName(channel?.name ?? '')
    setTopic(channel?.topic ?? '')
    setCategoryId(channel?.category_id ?? '')
    setTtl(channel?.disappearing_ttl ?? null)
    setTargetType('role')
    setTargetId('')
    setPermissionsSavingKey(null)
    setDeleteConfirm('')
    setActiveSection('overview')
  }, [channel?.category_id, channel?.disappearing_ttl, channel?.id, channel?.name, channel?.topic])

  const sections: SettingsSectionGroup[] = useMemo(
    () => [
      {
        title: isCategory ? 'Category Settings' : 'Channel Settings',
        items: [
          { id: 'overview', label: 'Overview', icon: Settings },
          ...(!isCategory ? [{ id: 'permissions', label: 'Permissions', icon: Lock }] : []),
          ...(!isCategory ? [{ id: 'behavior', label: 'Behavior', icon: Timer }] : []),
          ...(isOwner ? [{ id: 'danger', label: 'Danger Zone', tone: 'danger' as const, icon: AlertTriangle }] : [])
        ]
      }
    ],
    [isCategory, isOwner]
  )

  useEffect(() => {
    if (!server || !channel || !activeServerId) {
      return
    }

    if (activeSection !== 'permissions' || isCategory) {
      return
    }

    void fetchMembers(activeServerId)
    void fetchRoles(activeServerId)
    void fetchChannelPermissionOverrides(activeServerId, channel.id)
  }, [
    activeSection,
    activeServerId,
    channel?.id,
    fetchChannelPermissionOverrides,
    fetchMembers,
    fetchRoles,
    isCategory
  ])

  if (!server || !channel || !activeServerId || !isOwner) {
    return null
  }

  const categories = sortChannels(server.channels.filter((entry) => entry.type === 'category'))
  const siblings = sortChannels(
    server.channels.filter((entry) =>
      channel.type === 'category'
        ? entry.type === 'category'
        : entry.type !== 'category' && entry.category_id === (channel.category_id ?? null)
    )
  )
  const siblingIndex = siblings.findIndex((entry) => entry.id === channel.id)
  const canMoveUp = siblingIndex > 0
  const canMoveDown = siblingIndex >= 0 && siblingIndex < siblings.length - 1

  const isDirty =
    name.trim() !== channel.name ||
    topic.trim() !== (channel.topic ?? '') ||
    (categoryId || null) !== (channel.category_id ?? null) ||
    ttl !== (channel.disappearing_ttl ?? null)

  const handleSave = async (): Promise<void> => {
    const nextName = name.trim()
    if (!nextName) {
      return
    }

    setSaving(true)
    const updated = await updateChannel(activeServerId, channel.id, {
      name: nextName,
      topic: isCategory ? null : topic.trim() || null,
      category_id: isCategory ? null : categoryId || null,
      disappearing_ttl: isCategory ? null : ttl
    })
    setSaving(false)

    if (updated) {
      setName(updated.name)
      setTopic(updated.topic ?? '')
      setCategoryId(updated.category_id ?? '')
      setTtl(updated.disappearing_ttl ?? null)
    }
  }

  const handleMove = async (direction: -1 | 1): Promise<void> => {
    if (!canMoveUp && direction < 0) {
      return
    }
    if (!canMoveDown && direction > 0) {
      return
    }

    await updateChannel(activeServerId, channel.id, {
      position: Math.max(0, channel.position + direction),
      category_id: isCategory ? null : channel.category_id ?? null
    })
  }

  const handleDelete = async (): Promise<void> => {
    if (deleteConfirm !== channel.name) {
      return
    }

    const deleted = await deleteChannel(activeServerId, channel.id)
    if (deleted) {
      closeChannelSettingsModal()
    }
  }

  const roleOptions = roles.filter((role) => role.id.length > 0)
  const userOptions = members.filter((member) => member.user_id.length > 0)

  const updatePermissionDecision = async (
    override: ChannelPermissionOverride,
    permission: 'view' | 'send',
    decision: PermissionDecision
  ): Promise<void> => {
    const payload: PermissionOverrideUpsertInput = {
      target_type: override.target_type,
      target_id: override.target_id,
      allow_view_channel: override.allow_view_channel,
      deny_view_channel: override.deny_view_channel,
      allow_send_messages: override.allow_send_messages,
      deny_send_messages: override.deny_send_messages
    }

    if (permission === 'view') {
      payload.allow_view_channel = decision === 'allow'
      payload.deny_view_channel = decision === 'deny'
    } else {
      payload.allow_send_messages = decision === 'allow'
      payload.deny_send_messages = decision === 'deny'
    }

    const key = `${override.target_type}:${override.target_id}:${permission}`
    setPermissionsSavingKey(key)
    await saveChannelPermissionOverride(activeServerId, channel.id, payload)
    setPermissionsSavingKey(null)
  }

  const handleCreateOverride = async (): Promise<void> => {
    if (!targetId) {
      return
    }

    setPermissionsSavingKey(`create:${targetType}:${targetId}`)
    await saveChannelPermissionOverride(activeServerId, channel.id, {
      target_type: targetType,
      target_id: targetId,
      allow_view_channel: false,
      deny_view_channel: false,
      allow_send_messages: false,
      deny_send_messages: false
    })
    setPermissionsSavingKey(null)
    setTargetId('')
  }

  const getTargetDisplayName = (
    override: ChannelPermissionOverride
  ): { name: string; subtitle: string } => {
    if (override.target_type === 'role') {
      const role = roles.find((entry) => entry.id === override.target_id)
      return {
        name: role?.name || override.target_id,
        subtitle: 'Role'
      }
    }

    const member = members.find((entry) => entry.user_id === override.target_id)
    return {
      name: member?.user.display_name || member?.user.username || override.target_id,
      subtitle: 'Member'
    }
  }

  return (
    <SettingsShell
      title={isCategory ? 'Category Settings' : 'Channel Settings'}
      activeSection={activeSection}
      sections={sections}
      onSectionChange={(sectionId) => setActiveSection(sectionId as ChannelSettingsSection)}
      onClose={closeChannelSettingsModal}
    >
      {activeSection === 'overview' && (
        <>
          <div className="vesper-settings-page-header">
            <div>
              <h1 className="vesper-settings-page-title">{isCategory ? 'Category Overview' : 'Channel Overview'}</h1>
              <p className="vesper-settings-page-description">
                {isCategory ? 'Rename and organize this channel group.' : 'Rename this channel, set its topic, and place it where it belongs.'}
              </p>
            </div>
          </div>

          <div className="vesper-settings-card">
            <div className="vesper-settings-server-hero">
              <div className="vesper-settings-server-glyph vesper-settings-channel-glyph">
                {getChannelIcon(channel)}
              </div>
              <div>
                <div className="vesper-settings-profile-name">{channel.name}</div>
                <div className="vesper-settings-profile-note">
                  {isCategory ? `${siblings.length - 1} sibling categories` : `${channel.type} channel in ${server.name}`}
                </div>
              </div>
            </div>

            <div className="vesper-settings-form-grid">
              <label className="vesper-settings-field">
                <span className="vesper-settings-label">{isCategory ? 'Category Name' : 'Channel Name'}</span>
                <input
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="vesper-settings-input"
                />
              </label>

              <label className="vesper-settings-field">
                <span className="vesper-settings-label">{isCategory ? 'Category ID' : 'Channel ID'}</span>
                <div className="vesper-settings-inline-row">
                  <input
                    type="text"
                    value={channel.id}
                    readOnly
                    className="vesper-settings-input vesper-settings-input-disabled"
                  />
                  <button
                    type="button"
                    onClick={() => navigator.clipboard.writeText(channel.id)}
                    className="vesper-settings-icon-button"
                    title="Copy ID"
                  >
                    <Copy className="w-4 h-4" />
                  </button>
                </div>
              </label>

              {!isCategory && (
                <label className="vesper-settings-field">
                  <span className="vesper-settings-label">Category</span>
                  <select
                    value={categoryId}
                    onChange={(event) => setCategoryId(event.target.value)}
                    className="vesper-settings-select"
                  >
                    <option value="">No category</option>
                    {categories.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {!isCategory && (
                <label className="vesper-settings-field">
                  <span className="vesper-settings-label">Topic</span>
                  <textarea
                    value={topic}
                    onChange={(event) => setTopic(event.target.value)}
                    placeholder="What should people use this channel for?"
                    className="vesper-settings-input vesper-settings-textarea"
                    rows={4}
                  />
                </label>
              )}
            </div>

            <div className="vesper-settings-row">
              <div>
                <div className="vesper-settings-row-title">Order</div>
                <div className="vesper-settings-row-copy">
                  Use drag and drop in the sidebar, or nudge this {isCategory ? 'category' : 'channel'} one step at a time here.
                </div>
              </div>
              <div className="vesper-settings-inline-row">
                <button
                  type="button"
                  onClick={() => {
                    void handleMove(-1)
                  }}
                  disabled={!canMoveUp}
                  className="vesper-settings-secondary-button"
                >
                  <ArrowUp className="w-4 h-4" />
                  Move Up
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void handleMove(1)
                  }}
                  disabled={!canMoveDown}
                  className="vesper-settings-secondary-button"
                >
                  <ArrowDown className="w-4 h-4" />
                  Move Down
                </button>
              </div>
            </div>

            <div className="vesper-settings-card-actions">
              <button
                type="button"
                onClick={() => {
                  void handleSave()
                }}
                disabled={saving || !name.trim() || !isDirty}
                className="vesper-settings-primary-button"
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </>
      )}

      {activeSection === 'behavior' && !isCategory && (
        <>
          <div className="vesper-settings-page-header">
            <div>
              <h1 className="vesper-settings-page-title">Behavior</h1>
              <p className="vesper-settings-page-description">Control how messages behave in this channel.</p>
            </div>
          </div>

          <div className="vesper-settings-card">
            <label className="vesper-settings-field">
              <span className="vesper-settings-label">Disappearing Messages</span>
              <select
                value={ttl === null ? 'off' : String(ttl)}
                onChange={(event) => {
                  setTtl(event.target.value === 'off' ? null : Number(event.target.value))
                }}
                className="vesper-settings-select"
              >
                {TTL_OPTIONS.map((option) => (
                  <option
                    key={option.label}
                    value={option.value === null ? 'off' : String(option.value)}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="vesper-settings-row">
              <div>
                <div className="vesper-settings-row-title">Current Policy</div>
                <div className="vesper-settings-row-copy">
                  {ttl === null ? 'Messages stay until someone deletes them.' : `Messages expire after ${TTL_OPTIONS.find((option) => option.value === ttl)?.label?.toLowerCase() ?? `${ttl} seconds`}.`}
                </div>
              </div>
            </div>

            <div className="vesper-settings-card-actions">
              <button
                type="button"
                onClick={() => {
                  void handleSave()
                }}
                disabled={saving || !isDirty}
                className="vesper-settings-primary-button"
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </>
      )}

      {activeSection === 'permissions' && !isCategory && (
        <>
          <div className="vesper-settings-page-header">
            <div>
              <h1 className="vesper-settings-page-title">Permission Overrides</h1>
              <p className="vesper-settings-page-description">
                Set per-role and per-user access for viewing and sending in this channel.
              </p>
            </div>
          </div>

          <div className="vesper-settings-card">
            <div className="vesper-settings-target-row">
              <select
                value={targetType}
                onChange={(event) => {
                  setTargetType(event.target.value as 'role' | 'user')
                  setTargetId('')
                }}
                className="vesper-settings-select"
              >
                <option value="role">Role</option>
                <option value="user">Member</option>
              </select>
              <select
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
                className="vesper-settings-select"
              >
                <option value="">Select {targetType === 'role' ? 'role' : 'member'}</option>
                {targetType === 'role'
                  ? roleOptions.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))
                  : userOptions.map((member) => (
                    <option key={member.user_id} value={member.user_id}>
                      {member.user.display_name || member.user.username}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  void handleCreateOverride()
                }}
                disabled={!targetId || permissionsSavingKey?.startsWith('create:') === true}
                className="vesper-settings-secondary-button"
              >
                Add Override
              </button>
            </div>

            <div className="vesper-settings-permission-list">
              {permissionOverrides.length === 0 ? (
                <div className="vesper-settings-note-pill">No permission overrides set for this channel.</div>
              ) : (
                permissionOverrides.map((override) => {
                  const target = getTargetDisplayName(override)
                  const viewDecision = getPermissionDecision(
                    override.allow_view_channel,
                    override.deny_view_channel
                  )
                  const sendDecision = getPermissionDecision(
                    override.allow_send_messages,
                    override.deny_send_messages
                  )

                  return (
                    <div
                      key={`${override.target_type}:${override.target_id}`}
                      className="vesper-settings-permission-row"
                    >
                      <div className="vesper-settings-permission-target">
                        <div className="vesper-settings-member-name">{target.name}</div>
                        <div className="vesper-settings-member-meta">{target.subtitle}</div>
                      </div>

                      <div className="vesper-settings-permission-controls">
                        <PermissionToggle
                          label="View"
                          decision={viewDecision}
                          pending={permissionsSavingKey === `${override.target_type}:${override.target_id}:view`}
                          onChange={(decision) => {
                            void updatePermissionDecision(override, 'view', decision)
                          }}
                        />
                        <PermissionToggle
                          label="Send"
                          decision={sendDecision}
                          pending={permissionsSavingKey === `${override.target_type}:${override.target_id}:send`}
                          onChange={(decision) => {
                            void updatePermissionDecision(override, 'send', decision)
                          }}
                        />
                      </div>

                      <button
                        type="button"
                        className="vesper-settings-icon-button vesper-settings-icon-button-danger"
                        onClick={() => {
                          void deleteChannelPermissionOverride(
                            activeServerId,
                            channel.id,
                            override.target_type,
                            override.target_id
                          )
                        }}
                        title="Remove override"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </>
      )}

      {activeSection === 'danger' && (
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
              <span>{isCategory ? 'Delete Category' : 'Delete Channel'}</span>
            </div>
            <p className="vesper-settings-row-copy">
              {isCategory
                ? 'Deleting a category keeps its channels, but moves them out to the root of the server.'
                : 'Deleting this channel removes it from the server immediately.'}
            </p>
            <label className="vesper-settings-field">
              <span className="vesper-settings-label">Type {channel.name} to confirm</span>
              <input
                type="text"
                value={deleteConfirm}
                onChange={(event) => setDeleteConfirm(event.target.value)}
                placeholder={channel.name}
                className="vesper-settings-input"
              />
            </label>
            <div className="vesper-settings-card-actions">
              <button
                type="button"
                onClick={() => {
                  void handleDelete()
                }}
                disabled={deleteConfirm !== channel.name}
                className="vesper-settings-danger-button"
              >
                <Trash2 className="w-4 h-4" />
                Delete {isCategory ? 'Category' : 'Channel'}
              </button>
            </div>
          </div>
        </>
      )}
    </SettingsShell>
  )
}

function PermissionToggle({
  label,
  decision,
  pending,
  onChange
}: {
  label: string
  decision: PermissionDecision
  pending: boolean
  onChange: (decision: PermissionDecision) => void
}): React.JSX.Element {
  return (
    <div className="vesper-settings-permission-toggle">
      <span className="vesper-settings-label">{label}</span>
      <div className="vesper-settings-permission-buttons">
        <button
          type="button"
          onClick={() => onChange('inherit')}
          disabled={pending}
          className={`vesper-settings-permission-button${decision === 'inherit' ? ' vesper-settings-permission-button-active' : ''}`}
        >
          Inherit
        </button>
        <button
          type="button"
          onClick={() => onChange('allow')}
          disabled={pending}
          className={`vesper-settings-permission-button vesper-settings-permission-button-allow${decision === 'allow' ? ' vesper-settings-permission-button-active' : ''}`}
        >
          Allow
        </button>
        <button
          type="button"
          onClick={() => onChange('deny')}
          disabled={pending}
          className={`vesper-settings-permission-button vesper-settings-permission-button-deny${decision === 'deny' ? ' vesper-settings-permission-button-active' : ''}`}
        >
          Deny
        </button>
      </div>
    </div>
  )
}
