import { useEffect, useRef, useState } from 'react'
import { Bell, Globe, Laptop2, Lock, Mic, Moon, Palette, Pencil, Shield, Sun, UserRound, Volume2 } from 'lucide-react'
import { getLocalDeviceIdentity } from '@vesper/sdk/auth'
import { usePresenceStore } from '../../stores/presenceStore'
import { useUIStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useVoiceStore } from '../../stores/voiceStore'
import { useAuthStore } from '../../stores/authStore'
import { isPushEnabled, subscribeToPush, unsubscribeFromPush } from '../../utils/pushSubscription'
import Avatar from '../ui/Avatar'
import ImageCropModal from '../ui/ImageCropModal'
import SettingsShell, { type SettingsSectionGroup } from './SettingsShell'
import { getStoredValue, setStoredValue, getStoredJson, setStoredJson } from '../../utils/localStorage'
import { type ThemeOption, applyTheme, watchSystemTheme } from '../../utils/theme'

type UserSettingsSection = 'profile' | 'appearance' | 'notifications' | 'voice' | 'privacy' | 'advanced'

interface AudioDevice {
  deviceId: string
  label: string
}

function useAudioDevices(): { inputs: AudioDevice[]; outputs: AudioDevice[]; loading: boolean; reload: () => Promise<void> } {
  const [inputs, setInputs] = useState<AudioDevice[]>([])
  const [outputs, setOutputs] = useState<AudioDevice[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function enumerate(): Promise<void> {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        setInputs(
          devices
            .filter((device) => device.kind === 'audioinput')
            .map((device) => ({
              deviceId: device.deviceId,
              label: device.label || `Microphone ${device.deviceId.slice(0, 8)}`
            }))
        )
        setOutputs(
          devices
            .filter((device) => device.kind === 'audiooutput')
            .map((device) => ({
              deviceId: device.deviceId,
              label: device.label || `Speaker ${device.deviceId.slice(0, 8)}`
            }))
        )
      } catch {
        // Permission denied or unavailable
      } finally {
        setLoading(false)
      }
    }

    void enumerate()

    const handleDeviceChange = (): void => {
      setLoading(true)
      void enumerate()
    }

    navigator.mediaDevices?.addEventListener?.('devicechange', handleDeviceChange)

    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', handleDeviceChange)
    }
  }, [])

  return {
    inputs,
    outputs,
    loading,
    reload: async () => {
      setLoading(true)
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        setInputs(
          devices
            .filter((device) => device.kind === 'audioinput')
            .map((device) => ({
              deviceId: device.deviceId,
              label: device.label || `Microphone ${device.deviceId.slice(0, 8)}`
            }))
        )
        setOutputs(
          devices
            .filter((device) => device.kind === 'audiooutput')
            .map((device) => ({
              deviceId: device.deviceId,
              label: device.label || `Speaker ${device.deviceId.slice(0, 8)}`
            }))
        )
      } finally {
        setLoading(false)
      }
    }
  }
}

async function playSpeakerTestTone(outputDeviceId: string | null, volume: number): Promise<void> {
  const audioContext = new AudioContext()
  const destination = audioContext.createMediaStreamDestination()
  const oscillator = audioContext.createOscillator()
  const gainNode = audioContext.createGain()
  const audio = document.createElement('audio') as HTMLAudioElement & {
    setSinkId?: (deviceId: string) => Promise<void>
  }

  audio.srcObject = destination.stream
  audio.autoplay = true
  audio.volume = Math.max(0, Math.min(2, volume / 100))

  if (outputDeviceId && typeof audio.setSinkId === 'function') {
    await audio.setSinkId(outputDeviceId)
  }

  oscillator.type = 'sine'
  oscillator.frequency.value = 660
  gainNode.gain.value = 0.08
  oscillator.connect(gainNode)
  gainNode.connect(destination)
  await audio.play()
  oscillator.start()
  oscillator.stop(audioContext.currentTime + 0.35)

  await new Promise((resolve) => window.setTimeout(resolve, 500))

  audio.pause()
  audio.srcObject = null
  oscillator.disconnect()
  gainNode.disconnect()
  await audioContext.close()
}

export default function SettingsModal(): React.JSX.Element {
  const closeSettingsModal = useUIStore((s) => s.closeSettingsModal)
  const serverUrl = useSettingsStore((s) => s.serverUrl)
  const setServerUrl = useSettingsStore((s) => s.setServerUrl)
  const linkPreviewsEnabled = useSettingsStore((s) => s.linkPreviewsEnabled)
  const setLinkPreviewsEnabled = useSettingsStore((s) => s.setLinkPreviewsEnabled)
  const inputDeviceId = useVoiceStore((s) => s.inputDeviceId)
  const outputDeviceId = useVoiceStore((s) => s.outputDeviceId)
  const echoCancellation = useVoiceStore((s) => s.echoCancellation)
  const noiseSuppression = useVoiceStore((s) => s.noiseSuppression)
  const autoGainControl = useVoiceStore((s) => s.autoGainControl)
  const inputVolume = useVoiceStore((s) => s.inputVolume)
  const outputVolume = useVoiceStore((s) => s.outputVolume)
  const inputSensitivity = useVoiceStore((s) => s.inputSensitivity)
  const setInputDevice = useVoiceStore((s) => s.setInputDevice)
  const setOutputDevice = useVoiceStore((s) => s.setOutputDevice)
  const setEchoCancellation = useVoiceStore((s) => s.setEchoCancellation)
  const setNoiseSuppression = useVoiceStore((s) => s.setNoiseSuppression)
  const setAutoGainControl = useVoiceStore((s) => s.setAutoGainControl)
  const setInputVolume = useVoiceStore((s) => s.setInputVolume)
  const setOutputVolume = useVoiceStore((s) => s.setOutputVolume)
  const setInputSensitivity = useVoiceStore((s) => s.setInputSensitivity)
  const noiseGateEnabled = useVoiceStore((s) => s.noiseGateEnabled)
  const noiseGateThresholdDb = useVoiceStore((s) => s.noiseGateThresholdDb)
  const setNoiseGateEnabled = useVoiceStore((s) => s.setNoiseGateEnabled)
  const setNoiseGateThresholdDb = useVoiceStore((s) => s.setNoiseGateThresholdDb)
  const user = useAuthStore((s) => s.user)
  const currentDevice = useAuthStore((s) => s.currentDevice)
  const devices = useAuthStore((s) => s.devices)
  const canUseE2EE = useAuthStore((s) => s.canUseE2EE)
  const authError = useAuthStore((s) => s.error)
  const updateProfile = useAuthStore((s) => s.updateProfile)
  const uploadAvatar = useAuthStore((s) => s.uploadAvatar)
  const uploadBanner = useAuthStore((s) => s.uploadBanner)
  const fetchDevices = useAuthStore((s) => s.fetchDevices)
  const approveDevice = useAuthStore((s) => s.approveDevice)
  const revokeDevice = useAuthStore((s) => s.revokeDevice)
  const myStatus = usePresenceStore((s) => s.myStatus)
  const localDevice = getLocalDeviceIdentity()
  const anonFilenames = useSettingsStore((s) => s.anonFilenames)
  const setAnonFilenames = useSettingsStore((s) => s.setAnonFilenames)
  const stripExif = useSettingsStore((s) => s.stripExif)
  const setStripExif = useSettingsStore((s) => s.setStripExif)

  const avatarInputRef = useRef<HTMLInputElement>(null)
  const bannerInputRef = useRef<HTMLInputElement>(null)
  const [activeSection, setActiveSection] = useState<UserSettingsSection>('profile')
  const [avatarCropFile, setAvatarCropFile] = useState<File | null>(null)
  const [bannerCropFile, setBannerCropFile] = useState<File | null>(null)
  const [url, setUrl] = useState(serverUrl)
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const [displayName, setDisplayName] = useState(user?.display_name || '')
  const [profileSaved, setProfileSaved] = useState(false)
  const [theme, setTheme] = useState<ThemeOption>(
    () => (getStoredValue('theme') as ThemeOption) || 'auto'
  )
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    () => getStoredValue('notifications') !== 'disabled'
  )
  const [pushEnabled, setPushEnabled] = useState(() => isPushEnabled())
  const [pushBusy, setPushBusy] = useState(false)
  const pushAvailable = typeof window !== 'undefined' && !window.cryptoDb && 'PushManager' in window

  const { inputs, outputs } = useAudioDevices()
  const [testingSpeaker, setTestingSpeaker] = useState(false)
  const [deviceNicknames, setDeviceNicknames] = useState<Record<string, string>>(
    () => getStoredJson('deviceNicknames', {})
  )
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null)
  const [editingDeviceName, setEditingDeviceName] = useState('')

  useEffect(() => {
    setDisplayName(user?.display_name || '')
  }, [user?.display_name])

  useEffect(() => {
    void fetchDevices().catch(() => {})
  }, [fetchDevices])

  const sections: SettingsSectionGroup[] = [
    {
      title: 'User Settings',
      items: [
        { id: 'profile', label: 'My Account', icon: UserRound },
        { id: 'appearance', label: 'Appearance', icon: Palette },
        { id: 'notifications', label: 'Notifications', icon: Bell },
        { id: 'voice', label: 'Voice & Video', icon: Volume2 },
        { id: 'privacy', label: 'Privacy', icon: Lock },
        { id: 'advanced', label: 'Advanced', icon: Shield }
      ]
    }
  ]

  const handleSaveProfile = async (): Promise<void> => {
    const ok = await updateProfile({ display_name: displayName.trim() || null })
    if (ok) {
      setProfileSaved(true)
      window.setTimeout(() => setProfileSaved(false), 2000)
    }
  }

  const handleThemeChange = (nextTheme: ThemeOption): void => {
    setTheme(nextTheme)
    setStoredValue('theme', nextTheme)
    applyTheme(nextTheme)

    // Watch system changes when auto is selected
    if (nextTheme === 'auto') {
      watchSystemTheme((resolved) => {
        document.documentElement.setAttribute('data-theme', resolved)
      })
    }
  }

  const handleNotificationToggle = (): void => {
    const enabled = !notificationsEnabled
    setNotificationsEnabled(enabled)
    setStoredValue('notifications', enabled ? 'enabled' : 'disabled')
  }

  const handlePushToggle = async (): Promise<void> => {
    if (pushBusy) return
    setPushBusy(true)
    try {
      if (pushEnabled) {
        await unsubscribeFromPush()
        setPushEnabled(false)
      } else {
        const ok = await subscribeToPush()
        setPushEnabled(ok)
      }
    } finally {
      setPushBusy(false)
    }
  }

  const handleLinkPreviewToggle = (): void => {
    if (linkPreviewsEnabled) {
      setLinkPreviewsEnabled(false)
      return
    }

    const confirmed = window.confirm(
      'Link previews make external requests from your device. The linked site may see your IP address. Only enable this if that tradeoff is okay for you.'
    )

    if (confirmed) {
      setLinkPreviewsEnabled(true)
    }
  }

  const handleTestConnection = async (): Promise<void> => {
    setTestStatus('testing')
    try {
      const response = await fetch(`${url}/api/v1/auth/me`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      })
      setTestStatus(response.ok ? 'success' : 'error')
    } catch {
      setTestStatus('error')
    }
  }

  const handleSaveServerUrl = (): void => {
    setServerUrl(url)
  }

  const isProfileDirty = displayName !== (user?.display_name || '')
  const isServerUrlDirty = url !== serverUrl
  const profileBannerStyle = user?.banner_url ? { backgroundImage: `url("${user.banner_url}")` } : undefined

  return (
    <SettingsShell
      title="User Settings"
      activeSection={activeSection}
      sections={sections}
      onSectionChange={(sectionId) => setActiveSection(sectionId as UserSettingsSection)}
      onClose={closeSettingsModal}
    >
      {activeSection === 'profile' && (
        <>
          <div className="vesper-settings-page-header">
            <div>
              <h1 className="vesper-settings-page-title">My Account</h1>
            </div>
          </div>

          <div className="vesper-settings-profile-hero">
            <div
              className={`vesper-settings-profile-banner${user?.banner_url ? ' vesper-settings-profile-banner-image' : ''}`}
              style={profileBannerStyle}
            />
            <div className="vesper-settings-profile-avatar-row">
              <div className="vesper-settings-profile-avatar-stack">
                <Avatar
                  userId={user?.id || ''}
                  avatarUrl={user?.avatar_url}
                  displayName={user?.display_name || user?.username || '?'}
                  size="xl"
                  status={myStatus}
                />
                <button
                  type="button"
                  onClick={() => avatarInputRef.current?.click()}
                  className="vesper-settings-secondary-button"
                >
                  Change Avatar
                </button>
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) setAvatarCropFile(file)
                    event.target.value = ''
                  }}
                />
                <button
                  type="button"
                  onClick={() => bannerInputRef.current?.click()}
                  className="vesper-settings-secondary-button"
                >
                  Change Banner
                </button>
                <input
                  ref={bannerInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) setBannerCropFile(file)
                    event.target.value = ''
                  }}
                />
              </div>

              <div className="vesper-settings-profile-summary">
                <div className="vesper-settings-profile-name">{user?.display_name || user?.username}</div>
                <div className="vesper-settings-profile-handle">@{user?.username}</div>
              </div>
            </div>
          </div>

          <div className="vesper-settings-form-row">
            <label className="vesper-settings-field">
              <span className="vesper-settings-label">Username</span>
              <input
                type="text"
                value={user?.username || ''}
                disabled
                className="vesper-settings-input vesper-settings-input-disabled"
              />
            </label>

            <label className="vesper-settings-field">
              <span className="vesper-settings-label">Display Name</span>
              <input
                type="text"
                value={displayName}
                onChange={(event) => {
                  setDisplayName(event.target.value)
                  setProfileSaved(false)
                }}
                placeholder={user?.username || 'Display name'}
                className="vesper-settings-input"
              />
            </label>
          </div>

          <div className="vesper-settings-card-actions">
            <button
              type="button"
              onClick={handleSaveProfile}
              disabled={!isProfileDirty}
              className="vesper-settings-primary-button"
            >
              {profileSaved ? 'Saved' : 'Save Changes'}
            </button>
          </div>
          {avatarCropFile && (
            <ImageCropModal
              file={avatarCropFile}
              title="Change Avatar"
              cropShape="round"
              aspect={1}
              outputSize={{ width: 256, height: 256 }}
              onSubmit={async (blob) => {
                const croppedFile = new File([blob], 'avatar.png', { type: 'image/png' })
                await uploadAvatar(croppedFile)
                setAvatarCropFile(null)
              }}
              onClose={() => setAvatarCropFile(null)}
            />
          )}

          {bannerCropFile && (
            <ImageCropModal
              file={bannerCropFile}
              title="Change Banner"
              cropShape="rect"
              aspect={3}
              outputSize={{ width: 960, height: 320 }}
              onSubmit={async (blob) => {
                const croppedFile = new File([blob], 'banner.png', { type: 'image/png' })
                await uploadBanner(croppedFile)
                setBannerCropFile(null)
              }}
              onClose={() => setBannerCropFile(null)}
            />
          )}
        </>
      )}

      {activeSection === 'appearance' && (
        <>
          <div className="vesper-settings-page-header">
            <div>
              <h1 className="vesper-settings-page-title">Appearance</h1>
            </div>
          </div>

          <div className="vesper-settings-radio-grid">
            <button
              type="button"
              onClick={() => handleThemeChange('auto')}
              className={theme === 'auto' ? 'vesper-settings-choice vesper-settings-choice-active' : 'vesper-settings-choice'}
            >
              <Laptop2 className="w-4 h-4" />
              <span>Auto</span>
            </button>
            <button
              type="button"
              onClick={() => handleThemeChange('dark')}
              className={theme === 'dark' ? 'vesper-settings-choice vesper-settings-choice-active' : 'vesper-settings-choice'}
            >
              <Moon className="w-4 h-4" />
              <span>Dark</span>
            </button>
            <button
              type="button"
              onClick={() => handleThemeChange('light')}
              className={theme === 'light' ? 'vesper-settings-choice vesper-settings-choice-active' : 'vesper-settings-choice'}
            >
              <Sun className="w-4 h-4" />
              <span>Light</span>
            </button>
          </div>
        </>
      )}

      {activeSection === 'notifications' && (
        <>
          <div className="vesper-settings-page-header">
            <div>
              <h1 className="vesper-settings-page-title">Notifications</h1>
            </div>
          </div>

          <div className="vesper-settings-stack">
            <div className="vesper-settings-row">
              <div>
                <div className="vesper-settings-row-title">Desktop Notifications</div>
                <div className="vesper-settings-row-copy">Banners and mention alerts while the app is open.</div>
              </div>
              <button
                type="button"
                onClick={handleNotificationToggle}
                className={notificationsEnabled ? 'vesper-settings-toggle vesper-settings-toggle-on' : 'vesper-settings-toggle'}
                aria-pressed={notificationsEnabled}
                aria-label="Desktop Notifications"
              >
                <span className="vesper-settings-toggle-knob" />
              </button>
            </div>

            {pushAvailable && (
              <div className="vesper-settings-row">
                <div>
                  <div className="vesper-settings-row-title">Push Notifications</div>
                  <div className="vesper-settings-row-copy">Get notified for @mentions and DMs when the tab is closed.</div>
                </div>
                <button
                  type="button"
                  onClick={() => void handlePushToggle()}
                  disabled={pushBusy}
                  className={pushEnabled ? 'vesper-settings-toggle vesper-settings-toggle-on' : 'vesper-settings-toggle'}
                  aria-pressed={pushEnabled}
                  aria-label="Push Notifications"
                >
                  <span className="vesper-settings-toggle-knob" />
                </button>
              </div>
            )}

            <div className="vesper-settings-row">
              <div>
                <div className="vesper-settings-row-title">Link Previews</div>
                <div className="vesper-settings-row-copy">Fetch preview data from linked sites. They may see your IP.</div>
              </div>
              <button
                type="button"
                onClick={handleLinkPreviewToggle}
                className={linkPreviewsEnabled ? 'vesper-settings-toggle vesper-settings-toggle-on' : 'vesper-settings-toggle'}
                aria-pressed={linkPreviewsEnabled}
                aria-label="Link Previews"
              >
                <span className="vesper-settings-toggle-knob" />
              </button>
            </div>
          </div>
        </>
      )}

      {activeSection === 'voice' && (
        <>
          <div className="vesper-settings-page-header">
            <div>
              <h1 className="vesper-settings-page-title">Voice & Video</h1>
            </div>
          </div>

          <div className="vesper-settings-section-heading">Devices</div>
          <div className="vesper-settings-form-row">
            <label className="vesper-settings-field">
              <span className="vesper-settings-label">Input Device</span>
              <div className="vesper-settings-input-with-icon">
                <Mic className="w-4 h-4" />
                <select
                  value={inputDeviceId ?? ''}
                  onChange={(event) => setInputDevice(event.target.value || null)}
                  className="vesper-settings-select"
                >
                  <option value="">Default</option>
                  {inputs.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                </select>
              </div>
            </label>

            <label className="vesper-settings-field">
              <span className="vesper-settings-label">Output Device</span>
              <div className="vesper-settings-input-with-icon">
                <Volume2 className="w-4 h-4" />
                <select
                  value={outputDeviceId ?? ''}
                  onChange={(event) => setOutputDevice(event.target.value || null)}
                  className="vesper-settings-select"
                >
                  <option value="">Default</option>
                  {outputs.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                </select>
              </div>
            </label>
          </div>

          <div className="vesper-settings-section-heading">Processing</div>
          <div className="vesper-settings-stack">
            <div className="vesper-settings-row">
              <div>
                <div className="vesper-settings-row-title">Echo Cancellation</div>
              </div>
              <button
                type="button"
                onClick={() => setEchoCancellation(!echoCancellation)}
                className={echoCancellation ? 'vesper-settings-toggle vesper-settings-toggle-on' : 'vesper-settings-toggle'}
                aria-pressed={echoCancellation}
                aria-label="Echo Cancellation"
              >
                <span className="vesper-settings-toggle-knob" />
              </button>
            </div>

            <div className="vesper-settings-row">
              <div>
                <div className="vesper-settings-row-title">Noise Suppression</div>
              </div>
              <button
                type="button"
                onClick={() => setNoiseSuppression(!noiseSuppression)}
                className={noiseSuppression ? 'vesper-settings-toggle vesper-settings-toggle-on' : 'vesper-settings-toggle'}
                aria-pressed={noiseSuppression}
                aria-label="Noise Suppression"
              >
                <span className="vesper-settings-toggle-knob" />
              </button>
            </div>

            <div className="vesper-settings-row">
              <div>
                <div className="vesper-settings-row-title">Automatic Gain Control</div>
              </div>
              <button
                type="button"
                onClick={() => setAutoGainControl(!autoGainControl)}
                className={autoGainControl ? 'vesper-settings-toggle vesper-settings-toggle-on' : 'vesper-settings-toggle'}
                aria-pressed={autoGainControl}
                aria-label="Auto Gain Control"
              >
                <span className="vesper-settings-toggle-knob" />
              </button>
            </div>

            <div className="vesper-settings-row">
              <div>
                <div className="vesper-settings-row-title">Noise Gate</div>
              </div>
              <button
                type="button"
                onClick={() => setNoiseGateEnabled(!noiseGateEnabled)}
                className={noiseGateEnabled ? 'vesper-settings-toggle vesper-settings-toggle-on' : 'vesper-settings-toggle'}
                aria-pressed={noiseGateEnabled}
                aria-label="Noise Gate"
              >
                <span className="vesper-settings-toggle-knob" />
              </button>
            </div>
          </div>

          <div className="vesper-settings-form-grid">
            <label className="vesper-settings-field">
              <span className="vesper-settings-label">Input Volume</span>
              <input
                type="range"
                min={0}
                max={200}
                step={1}
                value={inputVolume}
                onChange={(event) => setInputVolume(Number(event.target.value))}
                className="vesper-settings-range"
              />
              <span className="vesper-settings-helper">{inputVolume}%</span>
            </label>

            <label className="vesper-settings-field">
              <span className="vesper-settings-label">Output Volume</span>
              <input
                type="range"
                min={0}
                max={200}
                step={1}
                value={outputVolume}
                onChange={(event) => setOutputVolume(Number(event.target.value))}
                className="vesper-settings-range"
              />
              <span className="vesper-settings-helper">{outputVolume}%</span>
            </label>

            <label className="vesper-settings-field">
              <span className="vesper-settings-label">Input Sensitivity</span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={inputSensitivity}
                onChange={(event) => setInputSensitivity(Number(event.target.value))}
                className="vesper-settings-range"
              />
              <span className="vesper-settings-helper">{inputSensitivity}%</span>
            </label>

            {noiseGateEnabled && (
              <label className="vesper-settings-field">
                <span className="vesper-settings-label">Noise Gate Threshold</span>
                <input
                  type="range"
                  min={-80}
                  max={-20}
                  step={1}
                  value={noiseGateThresholdDb}
                  onChange={(event) => setNoiseGateThresholdDb(Number(event.target.value))}
                  className="vesper-settings-range"
                />
                <span className="vesper-settings-helper">{noiseGateThresholdDb} dB</span>
              </label>
            )}
          </div>

          <div className="vesper-settings-row">
            <div>
              <div className="vesper-settings-row-title">Speaker Test</div>
            </div>
            <button
              type="button"
              onClick={async () => {
                setTestingSpeaker(true)
                try {
                  await playSpeakerTestTone(outputDeviceId, outputVolume)
                } finally {
                  setTestingSpeaker(false)
                }
              }}
              disabled={testingSpeaker}
              className="vesper-settings-secondary-button"
            >
              {testingSpeaker ? 'Testing...' : 'Play Test Tone'}
            </button>
          </div>
        </>
      )}

      {activeSection === 'privacy' && (
        <>
          <div className="vesper-settings-page-header">
            <div>
              <h1 className="vesper-settings-page-title">Privacy</h1>
            </div>
          </div>

          <div className="vesper-settings-section-heading">File Uploads</div>

          <div className="vesper-settings-stack">
            <div className="vesper-settings-row">
              <div>
                <div className="vesper-settings-row-title">Anonymous Filenames</div>
                <div className="vesper-settings-row-copy">
                  Replace original filenames with random characters when uploading. Prevents leaking file naming patterns or personal info in filenames.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setAnonFilenames(!anonFilenames)}
                className={anonFilenames ? 'vesper-settings-toggle vesper-settings-toggle-on' : 'vesper-settings-toggle'}
                aria-pressed={anonFilenames}
                aria-label="Anonymous Filenames"
              >
                <span className="vesper-settings-toggle-knob" />
              </button>
            </div>

            <div className="vesper-settings-row">
              <div>
                <div className="vesper-settings-row-title">Strip EXIF Data</div>
                <div className="vesper-settings-row-copy">
                  Remove metadata (location, camera info, timestamps) from images before uploading. Enabled by default for privacy.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setStripExif(!stripExif)}
                className={stripExif ? 'vesper-settings-toggle vesper-settings-toggle-on' : 'vesper-settings-toggle'}
                aria-pressed={stripExif}
                aria-label="Strip EXIF Data"
              >
                <span className="vesper-settings-toggle-knob" />
              </button>
            </div>
          </div>
        </>
      )}

      {activeSection === 'advanced' && (
        <>
          <div className="vesper-settings-page-header">
            <div>
              <h1 className="vesper-settings-page-title">Advanced</h1>
            </div>
          </div>

          <div className="vesper-settings-section-heading">Your Devices</div>

          {authError && (
            <div className="vesper-settings-feedback vesper-settings-feedback-error">
              {authError}
            </div>
          )}

          <div className="vesper-settings-stack">
            {devices.length === 0 ? (
              <div className="vesper-settings-helper">No devices yet.</div>
            ) : (
              devices.map((device) => (
                <div key={device.id} className="vesper-settings-row">
                  <div className="flex items-center gap-3">
                    <Laptop2 className="w-4 h-4 text-text-faint shrink-0" />
                    <div>
                      <div className="vesper-settings-row-title">
                        {editingDeviceId === device.id ? (
                          <form
                            className="flex items-center gap-2"
                            onSubmit={(e) => {
                              e.preventDefault()
                              const trimmed = editingDeviceName.trim()
                              if (trimmed) {
                                const next = { ...deviceNicknames, [device.id]: trimmed }
                                setDeviceNicknames(next)
                                setStoredJson('deviceNicknames', next)
                              } else {
                                const next = { ...deviceNicknames }
                                delete next[device.id]
                                setDeviceNicknames(next)
                                setStoredJson('deviceNicknames', next)
                              }
                              setEditingDeviceId(null)
                            }}
                          >
                            <input
                              type="text"
                              value={editingDeviceName}
                              onChange={(e) => setEditingDeviceName(e.target.value)}
                              className="vesper-settings-input"
                              style={{ padding: '0.3rem 0.5rem', fontSize: '0.85rem', width: '14rem' }}
                              autoFocus
                              onBlur={() => setEditingDeviceId(null)}
                              onKeyDown={(e) => { if (e.key === 'Escape') setEditingDeviceId(null) }}
                            />
                          </form>
                        ) : (
                          <>
                            {deviceNicknames[device.id] || device.name}
                            {device.client_id === localDevice.id ? ' · This device' : ''}
                            <button
                              type="button"
                              onClick={() => {
                                setEditingDeviceId(device.id)
                                setEditingDeviceName(deviceNicknames[device.id] || device.name)
                              }}
                              className="vesper-settings-inline-action"
                              title="Rename device"
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                          </>
                        )}
                      </div>
                      <div className="vesper-settings-row-copy">
                        {[device.platform, device.trust_state === 'trusted'
                          ? 'Approved'
                          : device.trust_state === 'pending'
                            ? 'Waiting for approval'
                            : 'Removed']
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </div>
                  </div>
                  {device.client_id === localDevice.id ? (
                    <span className="vesper-settings-helper">
                      {currentDevice?.trust_state === 'trusted' ? 'Current' : 'Needs approval'}
                    </span>
                  ) : (
                    <div className="flex items-center gap-2">
                      {device.trust_state === 'pending' && (
                        <button
                          type="button"
                          onClick={() => {
                            void approveDevice(device.id)
                          }}
                          className="vesper-settings-secondary-button"
                        >
                          Approve
                        </button>
                      )}
                      {device.trust_state !== 'revoked' && (
                        <button
                          type="button"
                          onClick={() => {
                            void revokeDevice(device.id)
                          }}
                          className="vesper-settings-secondary-button"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="vesper-settings-section-heading">Server URL</div>
          <label className="vesper-settings-field">
            <div className="vesper-settings-input-with-icon">
              <Globe className="w-4 h-4" />
              <input
                type="text"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value)
                  setTestStatus('idle')
                }}
                placeholder="http://localhost:4000"
                className="vesper-settings-input"
              />
            </div>
          </label>

          <div className="vesper-settings-card-actions">
            <button
              type="button"
              onClick={handleTestConnection}
              disabled={testStatus === 'testing'}
              className="vesper-settings-secondary-button"
            >
              {testStatus === 'testing' ? 'Testing...' : 'Test Connection'}
            </button>
            <button
              type="button"
              onClick={handleSaveServerUrl}
              disabled={!isServerUrlDirty}
              className="vesper-settings-primary-button"
            >
              Save URL
            </button>
          </div>

          {testStatus === 'success' && <div className="vesper-settings-feedback vesper-settings-feedback-success">Server reachable</div>}
          {testStatus === 'error' && <div className="vesper-settings-feedback vesper-settings-feedback-error">Could not reach the server</div>}
        </>
      )}
    </SettingsShell>
  )
}
