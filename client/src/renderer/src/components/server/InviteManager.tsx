import { useState, useEffect } from 'react'
import { Copy, Trash2, Plus, Clock, Users } from 'lucide-react'
import { apiFetch } from '../../api/client'
import { useServerStore } from '../../stores/serverStore'

interface Invite {
  id: string
  code: string
  max_uses: number | null
  uses: number
  expires_at: string | null
  creator: { id: string; username: string; display_name: string | null } | null
  inserted_at: string
}

const EXPIRY_OPTIONS = [
  { label: 'Never', value: 0 },
  { label: '30 minutes', value: 1800 },
  { label: '1 hour', value: 3600 },
  { label: '6 hours', value: 21600 },
  { label: '12 hours', value: 43200 },
  { label: '24 hours', value: 86400 },
  { label: '7 days', value: 604800 }
]

const MAX_USES_OPTIONS = [
  { label: 'No limit', value: 0 },
  { label: '1 use', value: 1 },
  { label: '5 uses', value: 5 },
  { label: '10 uses', value: 10 },
  { label: '25 uses', value: 25 },
  { label: '50 uses', value: 50 },
  { label: '100 uses', value: 100 }
]

export default function InviteManager(): React.JSX.Element {
  const activeServerId = useServerStore((s) => s.activeServerId)
  const [invites, setInvites] = useState<Invite[]>([])
  const [loading, setLoading] = useState(true)
  const [expirySeconds, setExpirySeconds] = useState(0)
  const [maxUses, setMaxUses] = useState(0)
  const [creating, setCreating] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [permanentCode, setPermanentCode] = useState<string | null>(null)

  const fetchInviteCode = async (): Promise<void> => {
    if (!activeServerId) return
    try {
      const res = await apiFetch(`/api/v1/servers/${activeServerId}/invite-code`)
      if (res.ok) {
        const data = await res.json()
        setPermanentCode(data.invite_code)
      }
    } catch {
      // no permission or error — don't show
    }
  }

  const fetchInvites = async (): Promise<void> => {
    if (!activeServerId) return
    try {
      const res = await apiFetch(`/api/v1/servers/${activeServerId}/invites`)
      if (res.ok) {
        const data = await res.json()
        setInvites(data.invites)
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchInvites()
    fetchInviteCode()
  }, [activeServerId])

  const createInvite = async (): Promise<void> => {
    if (!activeServerId) return
    setCreating(true)
    try {
      const body: Record<string, number> = {}
      if (expirySeconds > 0) body.expires_in_seconds = expirySeconds
      if (maxUses > 0) body.max_uses = maxUses

      const res = await apiFetch(`/api/v1/servers/${activeServerId}/invites`, {
        method: 'POST',
        body: JSON.stringify(body)
      })
      if (res.ok) {
        fetchInvites()
      }
    } catch {
      // ignore
    } finally {
      setCreating(false)
    }
  }

  const revokeInvite = async (inviteId: string): Promise<void> => {
    if (!activeServerId) return
    try {
      const res = await apiFetch(`/api/v1/servers/${activeServerId}/invites/${inviteId}`, {
        method: 'DELETE'
      })
      if (res.ok) {
        setInvites((prev) => prev.filter((i) => i.id !== inviteId))
      }
    } catch {
      // ignore
    }
  }

  const copyCode = (code: string): void => {
    navigator.clipboard.writeText(code)
    setCopied(code)
    setTimeout(() => setCopied(null), 2000)
  }

  const formatExpiry = (expiresAt: string | null): string => {
    if (!expiresAt) return 'Never'
    const exp = new Date(expiresAt)
    const now = new Date()
    if (exp <= now) return 'Expired'
    const diff = exp.getTime() - now.getTime()
    const hours = Math.floor(diff / 3600000)
    const minutes = Math.floor((diff % 3600000) / 60000)
    if (hours > 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
    if (hours > 0) return `${hours}h ${minutes}m`
    return `${minutes}m`
  }

  return (
    <div className="space-y-4">
      {/* Permanent invite code */}
      {permanentCode && (
        <div className="glass-card rounded-lg p-4">
          <h3 className="text-text-primary text-sm font-semibold mb-1">Server Invite Code</h3>
          <p className="text-text-faintest text-[10px] mb-2">Rotates every 24 hours</p>
          <div className="flex items-center gap-2">
            <code className="bg-bg-base/50 text-accent-text px-3 py-2 rounded-lg border border-border text-sm font-mono flex-1">
              {permanentCode}
            </code>
            <button
              onClick={() => copyCode(permanentCode)}
              className="p-2 text-text-faint hover:text-text-primary transition-colors rounded-lg hover:bg-bg-tertiary/50"
              title="Copy"
            >
              <Copy className="w-4 h-4" />
            </button>
            {copied === permanentCode && (
              <span className="text-emerald-400 text-[10px]">Copied!</span>
            )}
          </div>
        </div>
      )}

      {/* Create invite */}
      <div className="glass-card rounded-lg p-4">
        <h3 className="text-text-primary text-sm font-semibold mb-3">Create Invite Link</h3>
        <div className="flex flex-wrap gap-3 mb-3">
          <div>
            <label className="block text-text-muted text-xs mb-1">
              <Clock className="w-3 h-3 inline mr-1" />
              Expire after
            </label>
            <select
              value={expirySeconds}
              onChange={(e) => setExpirySeconds(Number(e.target.value))}
              className="bg-bg-base/50 text-text-secondary text-xs px-2 py-1.5 rounded-lg border border-border"
            >
              {EXPIRY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-text-muted text-xs mb-1">
              <Users className="w-3 h-3 inline mr-1" />
              Max uses
            </label>
            <select
              value={maxUses}
              onChange={(e) => setMaxUses(Number(e.target.value))}
              className="bg-bg-base/50 text-text-secondary text-xs px-2 py-1.5 rounded-lg border border-border"
            >
              {MAX_USES_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <button
          onClick={createInvite}
          disabled={creating}
          className="px-4 py-2 glow-accent hover:glow-accent-hover disabled:opacity-40 disabled:shadow-none text-bg-base rounded-lg text-sm font-medium transition-all flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          {creating ? 'Creating...' : 'Generate Invite Link'}
        </button>
      </div>

      {/* Invite list */}
      <div>
        <h3 className="text-text-muted text-xs font-medium mb-2 uppercase tracking-wider">
          Active Invites ({invites.length})
        </h3>
        {loading ? (
          <div className="text-text-faintest text-xs py-4 text-center">Loading...</div>
        ) : invites.length === 0 ? (
          <div className="text-text-faintest text-xs py-4 text-center">No active invite links</div>
        ) : (
          <div className="space-y-1.5">
            {invites.map((invite) => (
              <div
                key={invite.id}
                className="flex items-center gap-3 px-3 py-2 rounded-lg bg-bg-tertiary/30 hover:bg-bg-tertiary/50 transition-colors group"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="text-accent-text text-sm font-mono">{invite.code}</code>
                    <button
                      onClick={() => copyCode(invite.code)}
                      className="text-text-faint hover:text-text-primary transition-colors p-0.5"
                      title="Copy code"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                    {copied === invite.code && (
                      <span className="text-emerald-400 text-[10px]">Copied!</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-text-faintest text-[10px] mt-0.5">
                    <span>
                      by {invite.creator?.display_name || invite.creator?.username || 'Unknown'}
                    </span>
                    <span>
                      {invite.uses}{invite.max_uses ? `/${invite.max_uses}` : ''} uses
                    </span>
                    <span>
                      Expires: {formatExpiry(invite.expires_at)}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => revokeInvite(invite.id)}
                  className="opacity-0 group-hover:opacity-100 text-text-faint hover:text-red-400 transition-all p-1 rounded hover:bg-bg-tertiary/50"
                  title="Revoke"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
