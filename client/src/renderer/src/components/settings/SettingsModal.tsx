import { useState, useEffect, useRef } from 'react'
import { Settings, Sun, Moon, Bell, BellOff, Globe, Mic, Volume2, Loader2, Camera } from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useVoiceStore } from '../../stores/voiceStore'
import { useAuthStore } from '../../stores/authStore'
import Avatar from '../ui/Avatar'

interface AudioDevice {
  deviceId: string
  label: string
}

function useAudioDevices(): { inputs: AudioDevice[]; outputs: AudioDevice[] } {
  const [inputs, setInputs] = useState<AudioDevice[]>([])
  const [outputs, setOutputs] = useState<AudioDevice[]>([])

  useEffect(() => {
    async function enumerate(): Promise<void> {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        stream.getTracks().forEach((t) => t.stop())

        const devices = await navigator.mediaDevices.enumerateDevices()
        setInputs(
          devices
            .filter((d) => d.kind === 'audioinput')
            .map((d) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${d.deviceId.slice(0, 8)}` }))
        )
        setOutputs(
          devices
            .filter((d) => d.kind === 'audiooutput')
            .map((d) => ({ deviceId: d.deviceId, label: d.label || `Speaker ${d.deviceId.slice(0, 8)}` }))
        )
      } catch {
        // No mic permission
      }
    }
    enumerate()
  }, [])

  return { inputs, outputs }
}

export default function SettingsModal(): React.JSX.Element {
  const closeSettingsModal = useUIStore((s) => s.closeSettingsModal)
  const serverUrl = useSettingsStore((s) => s.serverUrl)
  const setServerUrl = useSettingsStore((s) => s.setServerUrl)
  const inputDeviceId = useVoiceStore((s) => s.inputDeviceId)
  const outputDeviceId = useVoiceStore((s) => s.outputDeviceId)
  const setInputDevice = useVoiceStore((s) => s.setInputDevice)
  const setOutputDevice = useVoiceStore((s) => s.setOutputDevice)

  const user = useAuthStore((s) => s.user)
  const updateProfile = useAuthStore((s) => s.updateProfile)
  const uploadAvatar = useAuthStore((s) => s.uploadAvatar)

  const avatarInputRef = useRef<HTMLInputElement>(null)
  const [avatarUploading, setAvatarUploading] = useState(false)

  const [url, setUrl] = useState(serverUrl)
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const [saved, setSaved] = useState(false)
  const [displayName, setDisplayName] = useState(user?.display_name || '')
  const [profileSaved, setProfileSaved] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('theme') as 'dark' | 'light') || 'dark'
  )
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    () => localStorage.getItem('notifications') !== 'disabled'
  )

  const { inputs, outputs } = useAudioDevices()

  const handleSaveProfile = async (): Promise<void> => {
    const ok = await updateProfile({ display_name: displayName.trim() || null })
    if (ok) {
      setProfileSaved(true)
      setTimeout(() => setProfileSaved(false), 2000)
    }
  }

  const handleThemeChange = (newTheme: 'dark' | 'light'): void => {
    setTheme(newTheme)
    localStorage.setItem('theme', newTheme)
    document.documentElement.setAttribute('data-theme', newTheme)
  }

  const handleNotificationToggle = (): void => {
    const enabled = !notificationsEnabled
    setNotificationsEnabled(enabled)
    localStorage.setItem('notifications', enabled ? 'enabled' : 'disabled')
  }

  const handleTest = async (): Promise<void> => {
    setTestStatus('testing')
    try {
      const res = await fetch(`${url}/api/v1/auth/me`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      })
      setTestStatus(res.status ? 'success' : 'error')
    } catch {
      setTestStatus('error')
    }
  }

  const handleSave = (): void => {
    setServerUrl(url)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="glass-card rounded-2xl p-6 w-[420px] max-w-[calc(100vw-2rem)] max-h-[80vh] overflow-y-auto animate-scale-in">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center">
            <Settings className="w-5 h-5 text-accent" />
          </div>
          <h2 className="text-lg font-semibold text-text-primary">Settings</h2>
        </div>

        {/* Profile */}
        <div className="mb-5">
          <h3 className="text-text-primary text-sm font-semibold mb-3">Profile</h3>

          {/* Avatar */}
          <div className="flex items-center gap-4 mb-4">
            <div className="relative group">
              <Avatar
                userId={user?.id || ''}
                avatarUrl={user?.avatar_url}
                displayName={user?.display_name || user?.username || '?'}
                size="lg"
              />
              <button
                onClick={() => avatarInputRef.current?.click()}
                disabled={avatarUploading}
                className="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
              >
                {avatarUploading ? (
                  <Loader2 className="w-5 h-5 text-white animate-spin" />
                ) : (
                  <Camera className="w-5 h-5 text-white" />
                )}
              </button>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  setAvatarUploading(true)
                  await uploadAvatar(file)
                  setAvatarUploading(false)
                  if (avatarInputRef.current) avatarInputRef.current.value = ''
                }}
              />
            </div>
            <div className="text-xs text-text-faint">
              <p>Click to upload avatar</p>
              <p>JPEG, PNG, GIF, WebP · Max 5MB</p>
            </div>
          </div>

          <div className="mb-3">
            <label className="block text-text-muted text-xs mb-1">Username</label>
            <input
              type="text"
              value={user?.username || ''}
              disabled
              className="w-full bg-bg-base/30 text-text-faint px-3 py-2 rounded-lg border border-border/50 text-sm cursor-not-allowed"
            />
          </div>
          <div className="mb-3">
            <label className="block text-text-muted text-xs mb-1">Display Name</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value)
                setProfileSaved(false)
              }}
              placeholder={user?.username || 'Display name'}
              className="w-full bg-bg-base/50 text-text-primary px-3 py-2 rounded-lg border border-border input-focus text-sm"
            />
          </div>
          <button
            onClick={handleSaveProfile}
            disabled={displayName === (user?.display_name || '')}
            className="px-3 py-1.5 glow-accent hover:glow-accent-hover disabled:opacity-40 disabled:shadow-none text-bg-base rounded-lg text-sm font-medium transition-all"
          >
            {profileSaved ? 'Saved!' : 'Update Profile'}
          </button>
        </div>

        {/* Appearance */}
        <div className="border-t border-border pt-4 mb-5">
          <h3 className="text-text-primary text-sm font-semibold mb-3">Appearance</h3>
          <div className="flex gap-2">
            <button
              onClick={() => handleThemeChange('dark')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                theme === 'dark'
                  ? 'bg-accent text-bg-base'
                  : 'bg-bg-base/50 text-text-muted hover:text-text-primary border border-border'
              }`}
            >
              <Moon className="w-4 h-4" />
              Dark
            </button>
            <button
              onClick={() => handleThemeChange('light')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                theme === 'light'
                  ? 'bg-accent text-bg-base'
                  : 'bg-bg-base/50 text-text-muted hover:text-text-primary border border-border'
              }`}
            >
              <Sun className="w-4 h-4" />
              Light
            </button>
          </div>
        </div>

        {/* Notifications */}
        <div className="border-t border-border pt-4 mb-5">
          <h3 className="text-text-primary text-sm font-semibold mb-3">Notifications</h3>
          <label className="flex items-center gap-3 text-text-secondary text-sm cursor-pointer group">
            <button
              onClick={handleNotificationToggle}
              className={`relative w-10 h-5 rounded-full transition-colors ${
                notificationsEnabled ? 'bg-accent' : 'bg-bg-tertiary'
              }`}
            >
              <span
                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  notificationsEnabled ? 'left-5' : 'left-0.5'
                }`}
              />
            </button>
            <span className="flex items-center gap-2 group-hover:text-text-primary transition-colors">
              {notificationsEnabled ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
              Desktop notifications
            </span>
          </label>
        </div>

        {/* Server URL */}
        <div className="border-t border-border pt-4 mb-5">
          <h3 className="text-text-primary text-sm font-semibold mb-3 flex items-center gap-2">
            <Globe className="w-4 h-4 text-text-muted" />
            Server
          </h3>
          <div className="mb-3">
            <label className="block text-text-muted text-xs mb-1">Server URL</label>
            <input
              type="text"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value)
                setTestStatus('idle')
                setSaved(false)
              }}
              placeholder="http://localhost:4000"
              className="w-full bg-bg-base/50 text-text-primary px-3 py-2 rounded-lg border border-border input-focus text-sm"
            />
            <p className="text-text-faintest text-xs mt-1">
              Requires app restart to take effect.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleTest}
              disabled={testStatus === 'testing'}
              className="px-3 py-1.5 bg-bg-tertiary/50 text-text-muted hover:text-text-primary rounded-lg text-sm transition-colors flex items-center gap-1.5"
            >
              {testStatus === 'testing' ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Testing...
                </>
              ) : (
                'Test Connection'
              )}
            </button>
            {testStatus === 'success' && (
              <span className="text-success text-sm animate-fade-in">Server reachable</span>
            )}
            {testStatus === 'error' && (
              <span className="text-error text-sm animate-fade-in">Cannot reach server</span>
            )}
          </div>
        </div>

        {/* Voice / Audio */}
        <div className="border-t border-border pt-4 mb-5">
          <h3 className="text-text-primary text-sm font-semibold mb-3">Voice</h3>

          <div className="mb-3">
            <label className="block text-text-muted text-xs mb-1 flex items-center gap-1.5">
              <Mic className="w-3.5 h-3.5" />
              Input Device
            </label>
            <select
              value={inputDeviceId ?? ''}
              onChange={(e) => setInputDevice(e.target.value || null)}
              className="w-full bg-bg-base/50 text-text-primary px-3 py-2 rounded-lg border border-border input-focus text-sm"
            >
              <option value="">Default</option>
              {inputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>

          <div className="mb-3">
            <label className="block text-text-muted text-xs mb-1 flex items-center gap-1.5">
              <Volume2 className="w-3.5 h-3.5" />
              Output Device
            </label>
            <select
              value={outputDeviceId ?? ''}
              onChange={(e) => setOutputDevice(e.target.value || null)}
              className="w-full bg-bg-base/50 text-text-primary px-3 py-2 rounded-lg border border-border input-focus text-sm"
            >
              <option value="">Default</option>
              {outputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <button
            onClick={closeSettingsModal}
            className="px-4 py-2 text-text-muted hover:text-text-primary text-sm transition-colors"
          >
            Close
          </button>
          <button
            onClick={handleSave}
            disabled={url === serverUrl}
            className="px-4 py-2 glow-accent hover:glow-accent-hover disabled:opacity-40 disabled:shadow-none text-bg-base rounded-lg text-sm font-medium transition-all"
          >
            {saved ? 'Saved!' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
