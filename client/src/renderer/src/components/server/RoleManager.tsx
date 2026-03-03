import { useState, useEffect } from 'react'
import { Shield, Loader2, Trash2 } from 'lucide-react'
import { apiFetch } from '../../api/client'
import { useServerStore } from '../../stores/serverStore'
import { useUIStore } from '../../stores/uiStore'

interface Role {
  id: string
  server_id: string
  name: string
  color: string | null
  permissions: number
  position: number
}

const PERMISSION_FLAGS = [
  { name: 'Send Messages', value: 1 },
  { name: 'Manage Messages', value: 2 },
  { name: 'Manage Channels', value: 4 },
  { name: 'Manage Server', value: 8 },
  { name: 'Kick Members', value: 16 },
  { name: 'Ban Members', value: 32 },
  { name: 'Invite Members', value: 64 },
  { name: 'Manage Roles', value: 128 },
  { name: 'Manage Voice', value: 256 },
  { name: 'Mention Everyone', value: 512 },
  { name: 'Administrator', value: 16384 }
] as const

export default function RoleManager({ embedded }: { embedded?: boolean } = {}): React.JSX.Element | null {
  const closeRoleManager = useUIStore((s) => s.closeRoleManager)
  const activeServerId = useServerStore((s) => s.activeServerId)

  const [roles, setRoles] = useState<Role[]>([])
  const [selectedRole, setSelectedRole] = useState<Role | null>(null)
  const [newRoleName, setNewRoleName] = useState('')
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('#3498db')
  const [editPermissions, setEditPermissions] = useState(0)

  useEffect(() => {
    if (activeServerId) fetchRoles()
  }, [activeServerId])

  const fetchRoles = async (): Promise<void> => {
    if (!activeServerId) return
    try {
      const res = await apiFetch(`/api/v1/servers/${activeServerId}/roles`)
      if (res.ok) {
        const data = await res.json()
        setRoles(data.roles)
      }
    } catch { /* ignore */ }
  }

  const createRole = async (): Promise<void> => {
    if (!activeServerId || !newRoleName.trim()) return
    try {
      const res = await apiFetch(`/api/v1/servers/${activeServerId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ name: newRoleName, permissions: 1, color: '#3498db' })
      })
      if (res.ok) {
        setNewRoleName('')
        fetchRoles()
      }
    } catch { /* ignore */ }
  }

  const saveRole = async (): Promise<void> => {
    if (!activeServerId || !selectedRole) return
    try {
      const res = await apiFetch(`/api/v1/servers/${activeServerId}/roles/${selectedRole.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: editName, color: editColor, permissions: editPermissions })
      })
      if (res.ok) {
        fetchRoles()
        setSelectedRole(null)
      }
    } catch { /* ignore */ }
  }

  const deleteRole = async (roleId: string): Promise<void> => {
    if (!activeServerId) return
    try {
      const res = await apiFetch(`/api/v1/servers/${activeServerId}/roles/${roleId}`, {
        method: 'DELETE'
      })
      if (res.ok) {
        if (selectedRole?.id === roleId) setSelectedRole(null)
        fetchRoles()
      }
    } catch { /* ignore */ }
  }

  const selectRole = (role: Role): void => {
    setSelectedRole(role)
    setEditName(role.name)
    setEditColor(role.color || '#3498db')
    setEditPermissions(role.permissions)
  }

  const togglePermission = (value: number): void => {
    setEditPermissions((prev) => prev ^ value)
  }

  const content = (
    <>
      {!embedded && (
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-violet/10 flex items-center justify-center">
            <Shield className="w-5 h-5 text-violet" />
          </div>
          <h2 className="text-lg font-semibold text-text-primary">Manage Roles</h2>
        </div>
      )}

      {/* Create role */}
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          value={newRoleName}
          onChange={(e) => setNewRoleName(e.target.value)}
          placeholder="New role name"
          className="flex-1 bg-bg-base/50 text-text-primary px-3 py-2 rounded-lg border border-border input-focus text-sm"
          onKeyDown={(e) => e.key === 'Enter' && createRole()}
        />
        <button
          onClick={createRole}
          disabled={!newRoleName.trim()}
          className="px-3 py-2 glow-accent hover:glow-accent-hover disabled:opacity-40 disabled:shadow-none text-bg-base rounded-lg text-sm font-medium transition-all"
        >
          Create
        </button>
      </div>

      <div className="flex gap-4">
        {/* Role list */}
        <div className="w-40 space-y-1">
          {roles.map((role) => (
            <button
              key={role.id}
              onClick={() => selectRole(role)}
              className={`w-full text-left px-3 py-1.5 text-sm rounded-lg flex items-center gap-2 transition-colors ${
                selectedRole?.id === role.id
                  ? 'bg-bg-tertiary text-text-primary'
                  : 'text-text-muted hover:text-text-primary hover:bg-bg-tertiary/30'
              }`}
            >
              {role.color && (
                <span
                  className="w-3 h-3 rounded-full shrink-0"
                  style={{ backgroundColor: role.color }}
                />
              )}
              <span className="truncate">{role.name}</span>
            </button>
          ))}
        </div>

        {/* Role editor */}
        {selectedRole && (
          <div className="flex-1 space-y-3">
            <div>
              <label className="block text-text-muted text-xs mb-1">Name</label>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="w-full bg-bg-base/50 text-text-primary px-3 py-2 rounded-lg border border-border input-focus text-sm"
              />
            </div>

            <div>
              <label className="block text-text-muted text-xs mb-1">Color</label>
              <input
                type="color"
                value={editColor}
                onChange={(e) => setEditColor(e.target.value)}
                className="w-8 h-8 rounded-lg cursor-pointer border border-border"
              />
            </div>

            <div>
              <label className="block text-text-muted text-xs mb-2">Permissions</label>
              <div className="space-y-1">
                {PERMISSION_FLAGS.map((perm) => (
                  <label
                    key={perm.value}
                    className="flex items-center gap-2 text-text-secondary text-sm cursor-pointer hover:text-text-primary transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={(editPermissions & perm.value) !== 0}
                      onChange={() => togglePermission(perm.value)}
                      className="rounded border-border accent-accent"
                    />
                    {perm.name}
                  </label>
                ))}
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                onClick={saveRole}
                className="px-3 py-1.5 glow-accent hover:glow-accent-hover text-bg-base rounded-lg text-sm font-medium transition-all"
              >
                Save
              </button>
              <button
                onClick={() => deleteRole(selectedRole.id)}
                className="px-3 py-1.5 bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </button>
            </div>
          </div>
        )}
      </div>

      {!embedded && (
        <div className="flex justify-end mt-4">
          <button
            onClick={closeRoleManager}
            className="px-4 py-2 text-text-muted hover:text-text-primary text-sm transition-colors"
          >
            Close
          </button>
        </div>
      )}
    </>
  )

  if (embedded) return content

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="glass-card rounded-2xl p-6 w-[560px] max-w-[calc(100vw-2rem)] max-h-[80vh] overflow-y-auto animate-scale-in">
        {content}
      </div>
    </div>
  )
}
