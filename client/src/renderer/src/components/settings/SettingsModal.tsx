import { useEffect, useRef, useState } from 'react'
import { Bell, Globe, Mic, Moon, Palette, RefreshCw, Shield, SlidersHorizontal, Sparkles, Sun, UserRound, Volume2 } from 'lucide-react'
import { usePresenceStore } from '../../stores/presenceStore'
import { useUIStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useVoiceStore } from '../../stores/voiceStore'
import { useAuthStore } from '../../stores/authStore'
import Avatar from '../ui/Avatar'
import SettingsShell, { type SettingsSectionGroup } from './SettingsShell'

type UserSettingsSection = 'profile' | 'appearance' | 'notifications' | 'voice' | 'advanced'

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
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        stream.getTracks().forEach((track) => track.stop())

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

function useMicrophoneLevel(options: {
  deviceId: string | null
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
  inputVolume: number
}): { level: number; supported: boolean } {
  const [level, setLevel] = useState(0)
  const [supported, setSupported] = useState(true)

  useEffect(() => {
    let cancelled = false
    let animationFrame = 0
    let stream: MediaStream | null = null
    let audioContext: AudioContext | null = null
    let source: MediaStreamAudioSourceNode | null = null
    let gainNode: GainNode | null = null
    let analyser: AnalyserNode | null = null

    async function start(): Promise<void> {
      if (!navigator.mediaDevices?.getUserMedia) {
        setSupported(false)
        return
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
            echoCancellation: options.echoCancellation,
            noiseSuppression: options.noiseSuppression,
            autoGainControl: options.autoGainControl
          }
        })

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }

        audioContext = new AudioContext()
        source = audioContext.createMediaStreamSource(stream)
        gainNode = audioContext.createGain()
        gainNode.gain.value = options.inputVolume / 100
        analyser = audioContext.createAnalyser()
        analyser.fftSize = 512
        source.connect(gainNode)
        gainNode.connect(analyser)

        const sample = (): void => {
          if (!analyser || cancelled) {
            return
          }

          const data = new Float32Array(analyser.fftSize)
          analyser.getFloatTimeDomainData(data)

          let sum = 0
          for (let index = 0; index < data.length; index += 1) {
            sum += data[index] * data[index]
          }

          const rms = Math.sqrt(sum / data.length)
          const nextLevel = Math.max(0, Math.min(100, Math.round(rms * 280)))
          setLevel(nextLevel)
          animationFrame = window.requestAnimationFrame(sample)
        }

        sample()
      } catch {
        setSupported(false)
      }
    }

    void start()

    return () => {
      cancelled = true
      window.cancelAnimationFrame(animationFrame)
      source?.disconnect()
      gainNode?.disconnect()
      analyser?.disconnect()
      if (audioContext) {
        audioContext.close().catch(() => {})
      }
      if (stream) {
        stream.getTracks().forEach((track) => track.stop())
      }
    }
  }, [
    options.autoGainControl,
    options.deviceId,
    options.echoCancellation,
    options.inputVolume,
    options.noiseSuppression
  ])

  return { level, supported }
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
  const connectionQuality = useVoiceStore((s) => s.connectionQuality)
  const roundTripMs = useVoiceStore((s) => s.roundTripMs)
  const packetLossPct = useVoiceStore((s) => s.packetLossPct)
  const jitterMs = useVoiceStore((s) => s.jitterMs)
  const inboundBitrateKbps = useVoiceStore((s) => s.inboundBitrateKbps)
  const outboundBitrateKbps = useVoiceStore((s) => s.outboundBitrateKbps)
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
  const updateProfile = useAuthStore((s) => s.updateProfile)
  const uploadAvatar = useAuthStore((s) => s.uploadAvatar)
  const uploadBanner = useAuthStore((s) => s.uploadBanner)
  const myStatus = usePresenceStore((s) => s.myStatus)

  const avatarInputRef = useRef<HTMLInputElement>(null)
  const bannerInputRef = useRef<HTMLInputElement>(null)
  const [activeSection, setActiveSection] = useState<UserSettingsSection>('profile')
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [bannerUploading, setBannerUploading] = useState(false)
  const [url, setUrl] = useState(serverUrl)
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const [displayName, setDisplayName] = useState(user?.display_name || '')
  const [profileSaved, setProfileSaved] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('theme') as 'dark' | 'light') || 'dark'
  )
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    () => localStorage.getItem('notifications') !== 'disabled'
  )

  const { inputs, outputs, loading: devicesLoading, reload: reloadDevices } = useAudioDevices()
  const { level: microphoneLevel, supported: micMeterSupported } = useMicrophoneLevel({
    deviceId: inputDeviceId,
    echoCancellation,
    noiseSuppression,
    autoGainControl,
    inputVolume
  })
  const [testingSpeaker, setTestingSpeaker] = useState(false)

  useEffect(() => {
    setDisplayName(user?.display_name || '')
  }, [user?.display_name])

  const sections: SettingsSectionGroup[] = [
    {
      title: 'User Settings',
      items: [
        { id: 'profile', label: 'My Account', icon: UserRound },
        { id: 'appearance', label: 'Appearance', icon: Palette },
        { id: 'notifications', label: 'Notifications', icon: Bell },
        { id: 'voice', label: 'Voice & Video', icon: Volume2 },
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

  const handleThemeChange = (nextTheme: 'dark' | 'light'): void => {
    setTheme(nextTheme)
    localStorage.setItem('theme', nextTheme)
    document.documentElement.setAttribute('data-theme', nextTheme)
  }

  const handleNotificationToggle = (): void => {
    const enabled = !notificationsEnabled
    setNotificationsEnabled(enabled)
    localStorage.setItem('notifications', enabled ? 'enabled' : 'disabled')
  }

  const handleLinkPreviewToggle = (): void => {
    setLinkPreviewsEnabled(!linkPreviewsEnabled)
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
  const connectionQualityLabel = {
    good: 'Good',
    fair: 'Fair',
    poor: 'Poor',
    unknown: 'No Data'
  }[connectionQuality]

  const formatLatency = (value: number | null): string => {
    if (value === null || !Number.isFinite(value)) {
      return 'n/a'
    }

    return `${Math.round(value)} ms`
  }

  const formatPacketLoss = (value: number | null): string => {
    if (value === null || !Number.isFinite(value)) {
      return 'n/a'
    }

    return `${value.toFixed(value >= 10 ? 0 : 1)}%`
  }

  const formatBitrate = (value: number | null): string => {
    if (value === null || !Number.isFinite(value)) {
      return 'n/a'
    }

    if (value >= 1000) {
      const megabits = value / 1000
      return `${megabits.toFixed(megabits >= 10 ? 0 : 1)} Mbps`
    }

    return `${value.toFixed(value >= 100 ? 0 : 1)} kbps`
  }

  const noiseGateThresholdPercent = Math.round(
    ((Math.max(-80, Math.min(-20, noiseGateThresholdDb)) + 80) / 60) * 100
  )

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
              <p className="vesper-settings-page-description">Manage your identity across Vesper.</p>
            </div>
          </div>

          <div className="vesper-settings-card">
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
                    size="lg"
                    status={myStatus}
                  />
                  <button
                    type="button"
                    onClick={() => avatarInputRef.current?.click()}
                    disabled={avatarUploading}
                    className="vesper-settings-secondary-button"
                  >
                    {avatarUploading ? 'Uploading...' : 'Change Avatar'}
                  </button>
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/gif,image/webp"
                    className="hidden"
                    onChange={async (event) => {
                      const file = event.target.files?.[0]
                      if (!file) {
                        return
                      }
                      setAvatarUploading(true)
                      await uploadAvatar(file)
                      setAvatarUploading(false)
                      if (avatarInputRef.current) {
                        avatarInputRef.current.value = ''
                      }
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => bannerInputRef.current?.click()}
                    disabled={bannerUploading}
                    className="vesper-settings-secondary-button"
                  >
                    {bannerUploading ? 'Uploading...' : 'Change Banner'}
                  </button>
                  <input
                    ref={bannerInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/gif,image/webp"
                    className="hidden"
                    onChange={async (event) => {
                      const file = event.target.files?.[0]
                      if (!file) {
                        return
                      }
                      setBannerUploading(true)
                      await uploadBanner(file)
                      setBannerUploading(false)
                      if (bannerInputRef.current) {
                        bannerInputRef.current.value = ''
                      }
                    }}
                  />
                </div>

                <div className="vesper-settings-profile-summary">
                  <div className="vesper-settings-profile-name">{user?.display_name || user?.username}</div>
                  <div className="vesper-settings-profile-handle">@{user?.username}</div>
                  <div className="vesper-settings-profile-note">Avatar: PNG, JPG, GIF, or WebP up to 5MB.</div>
                  <div className="vesper-settings-profile-note">Banner: PNG, JPG, GIF, or WebP up to 8MB.</div>
                </div>
              </div>
            </div>

            <div className="vesper-settings-form-grid">
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

            <div className="vesper-settings-profile-preview-shell">
              <div className="vesper-settings-profile-preview">
                <div
                  className={`vesper-settings-profile-preview-banner${user?.banner_url ? ' vesper-settings-profile-preview-banner-image' : ''}`}
                  style={profileBannerStyle}
                />
                <div className="vesper-settings-profile-preview-body">
                  <div className="vesper-settings-profile-preview-avatar">
                    <Avatar
                      userId={user?.id || ''}
                      avatarUrl={user?.avatar_url}
                      displayName={displayName.trim() || user?.username || '?'}
                      size="lg"
                      status={myStatus}
                    />
                  </div>
                  <div className="vesper-settings-profile-preview-copy">
                    <div className="vesper-settings-profile-preview-name">
                      {displayName.trim() || user?.display_name || user?.username}
                    </div>
                    <div className="vesper-settings-profile-preview-handle">@{user?.username}</div>
                    <div className="vesper-settings-profile-preview-tabs">
                      <span className="vesper-settings-profile-preview-tab vesper-settings-profile-preview-tab-active">About Me</span>
                      <span className="vesper-settings-profile-preview-tab">Connections</span>
                    </div>
                    <div className="vesper-settings-profile-preview-panel">
                      <div className="vesper-settings-profile-preview-label">Preview</div>
                      <p className="vesper-settings-profile-preview-text">
                        This is how your Vesper card will look when people open your profile.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {activeSection === 'appearance' && (
        <>
          <div className="vesper-settings-page-header">
            <div>
              <h1 className="vesper-settings-page-title">Appearance</h1>
              <p className="vesper-settings-page-description">Tune the look and feel of the app.</p>
            </div>
          </div>

          <div className="vesper-settings-card">
            <div className="vesper-settings-radio-grid">
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
          </div>
        </>
      )}

      {activeSection === 'notifications' && (
        <>
          <div className="vesper-settings-page-header">
            <div>
              <h1 className="vesper-settings-page-title">Notifications</h1>
              <p className="vesper-settings-page-description">Choose how Vesper gets your attention.</p>
            </div>
          </div>

          <div className="vesper-settings-card">
            <div className="vesper-settings-row">
              <div>
                <div className="vesper-settings-row-title">Desktop Notifications</div>
                <div className="vesper-settings-row-copy">Allow banners and mention alerts while the app is open.</div>
              </div>
              <button
                type="button"
                onClick={handleNotificationToggle}
                className={notificationsEnabled ? 'vesper-settings-toggle vesper-settings-toggle-on' : 'vesper-settings-toggle'}
                aria-pressed={notificationsEnabled}
              >
                <span className="vesper-settings-toggle-knob" />
              </button>
            </div>

            <div className="vesper-settings-note-pill">
              <Bell className="w-4 h-4" />
              <span>{notificationsEnabled ? 'Notifications are enabled.' : 'Notifications are disabled.'}</span>
            </div>
          </div>

          <div className="vesper-settings-card">
            <div className="vesper-settings-row">
              <div>
                <div className="vesper-settings-row-title">Link Previews</div>
                <div className="vesper-settings-row-copy">When enabled, this device may contact linked sites to fetch title and description data.</div>
              </div>
              <button
                type="button"
                onClick={handleLinkPreviewToggle}
                className={linkPreviewsEnabled ? 'vesper-settings-toggle vesper-settings-toggle-on' : 'vesper-settings-toggle'}
                aria-pressed={linkPreviewsEnabled}
              >
                <span className="vesper-settings-toggle-knob" />
              </button>
            </div>

            <div className="vesper-settings-note-pill">
              <Shield className="w-4 h-4" />
              <span>
                {linkPreviewsEnabled
                  ? 'Preview fetches happen from this device only. URLs are no longer sent to the Vesper server for previews.'
                  : 'Link previews are off. Vesper will not make automatic external requests for shared links.'}
              </span>
            </div>
          </div>
        </>
      )}

      {activeSection === 'voice' && (
        <>
          <div className="vesper-settings-page-header">
            <div>
              <h1 className="vesper-settings-page-title">Voice & Video</h1>
              <p className="vesper-settings-page-description">Tune the whole call path, from capture and cleanup to playback and diagnostics.</p>
            </div>
          </div>

          <div className="vesper-settings-card">
            <div className="vesper-settings-card-header-row">
              <div>
                <div className="vesper-settings-row-title">Devices</div>
                <div className="vesper-settings-row-copy">Device changes apply immediately, even while you are already connected.</div>
              </div>
              <button
                type="button"
                onClick={() => {
                  void reloadDevices()
                }}
                className="vesper-settings-icon-button"
                title="Refresh devices"
              >
                <RefreshCw className={`w-4 h-4${devicesLoading ? ' animate-spin' : ''}`} />
              </button>
            </div>
            <div className="vesper-settings-form-grid">
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

            <div className="vesper-settings-note-pill">
              <Sparkles className="w-4 h-4" />
              <span>Your microphone is processed locally before it is encrypted and sent.</span>
            </div>
          </div>

          <div className="vesper-settings-card">
            <div className="vesper-settings-card-header-row">
              <div>
                <div className="vesper-settings-row-title">Processing</div>
                <div className="vesper-settings-row-copy">These controls shape what goes into the encrypted voice stream and what comes out locally.</div>
              </div>
              <SlidersHorizontal className="w-4 h-4 text-text-faint" />
            </div>

            <div className="vesper-settings-stack">
              <div className="vesper-settings-row">
                <div>
                  <div className="vesper-settings-row-title">Echo Cancellation</div>
                  <div className="vesper-settings-row-copy">Reduce speaker bleed back into your mic.</div>
                </div>
                <button
                  type="button"
                  onClick={() => setEchoCancellation(!echoCancellation)}
                  className={echoCancellation ? 'vesper-settings-toggle vesper-settings-toggle-on' : 'vesper-settings-toggle'}
                  aria-pressed={echoCancellation}
                >
                  <span className="vesper-settings-toggle-knob" />
                </button>
              </div>

              <div className="vesper-settings-row">
                <div>
                  <div className="vesper-settings-row-title">Noise Suppression</div>
                  <div className="vesper-settings-row-copy">Trim background fan and room noise from your capture.</div>
                </div>
                <button
                  type="button"
                  onClick={() => setNoiseSuppression(!noiseSuppression)}
                  className={noiseSuppression ? 'vesper-settings-toggle vesper-settings-toggle-on' : 'vesper-settings-toggle'}
                  aria-pressed={noiseSuppression}
                >
                  <span className="vesper-settings-toggle-knob" />
                </button>
              </div>

              <div className="vesper-settings-row">
                <div>
                  <div className="vesper-settings-row-title">Automatic Gain Control</div>
                  <div className="vesper-settings-row-copy">Let the browser smooth out big mic volume swings for you.</div>
                </div>
                <button
                  type="button"
                  onClick={() => setAutoGainControl(!autoGainControl)}
                  className={autoGainControl ? 'vesper-settings-toggle vesper-settings-toggle-on' : 'vesper-settings-toggle'}
                  aria-pressed={autoGainControl}
                >
                  <span className="vesper-settings-toggle-knob" />
                </button>
              </div>

              <div className="vesper-settings-row">
                <div>
                  <div className="vesper-settings-row-title">Noise Gate</div>
                  <div className="vesper-settings-row-copy">Cut low-level room sound until your voice crosses the threshold.</div>
                </div>
                <button
                  type="button"
                  onClick={() => setNoiseGateEnabled(!noiseGateEnabled)}
                  className={noiseGateEnabled ? 'vesper-settings-toggle vesper-settings-toggle-on' : 'vesper-settings-toggle'}
                  aria-pressed={noiseGateEnabled}
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
          </div>

          <div className="vesper-settings-card">
            <div className="vesper-settings-card-header-row">
              <div>
                <div className="vesper-settings-row-title">Diagnostics</div>
                <div className="vesper-settings-row-copy">Check your mic path and test your selected output device before you jump into a call.</div>
              </div>
            </div>

            <div className="vesper-settings-stack">
              <div className="vesper-settings-field">
                <span className="vesper-settings-label">Microphone Test</span>
                <div className="vesper-settings-meter-shell">
                  <div
                    className="vesper-settings-meter-fill"
                    style={{ width: `${microphoneLevel}%` }}
                  />
                  {noiseGateEnabled && (
                    <span
                      className="vesper-settings-meter-threshold"
                      style={{ left: `${noiseGateThresholdPercent}%` }}
                      aria-hidden
                    />
                  )}
                </div>
                <span className="vesper-settings-helper">
                  {micMeterSupported ? `Live input level: ${microphoneLevel}%` : 'Microphone metering is unavailable in this browser.'}
                </span>
                {noiseGateEnabled && (
                  <span className="vesper-settings-helper">
                    Gate opens around {noiseGateThresholdDb} dB.
                  </span>
                )}
              </div>

              <div className="vesper-settings-row">
                <div>
                  <div className="vesper-settings-row-title">Speaker Test</div>
                  <div className="vesper-settings-row-copy">Play a short tone through your selected output device and current output volume.</div>
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

              <div className="vesper-settings-voice-diagnostics">
                <div className="vesper-settings-voice-diagnostics-header">
                  <div>
                    <div className="vesper-settings-row-title">Live Network Health</div>
                    <div className="vesper-settings-row-copy">Voice telemetry appears while Vesper has connection stats to report.</div>
                  </div>
                  <span
                    className={`vesper-settings-voice-quality-badge vesper-settings-voice-quality-badge-${connectionQuality}`}
                  >
                    {connectionQualityLabel}
                  </span>
                </div>

                <div className="vesper-settings-voice-metrics">
                  <div className="vesper-settings-voice-metric">
                    <span className="vesper-settings-voice-metric-label">RTT</span>
                    <span className="vesper-settings-voice-metric-value">{formatLatency(roundTripMs)}</span>
                  </div>
                  <div className="vesper-settings-voice-metric">
                    <span className="vesper-settings-voice-metric-label">Loss</span>
                    <span className="vesper-settings-voice-metric-value">{formatPacketLoss(packetLossPct)}</span>
                  </div>
                  <div className="vesper-settings-voice-metric">
                    <span className="vesper-settings-voice-metric-label">Jitter</span>
                    <span className="vesper-settings-voice-metric-value">{formatLatency(jitterMs)}</span>
                  </div>
                  <div className="vesper-settings-voice-metric">
                    <span className="vesper-settings-voice-metric-label">Inbound</span>
                    <span className="vesper-settings-voice-metric-value">{formatBitrate(inboundBitrateKbps)}</span>
                  </div>
                  <div className="vesper-settings-voice-metric">
                    <span className="vesper-settings-voice-metric-label">Outbound</span>
                    <span className="vesper-settings-voice-metric-value">{formatBitrate(outboundBitrateKbps)}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {activeSection === 'advanced' && (
        <>
          <div className="vesper-settings-page-header">
            <div>
              <h1 className="vesper-settings-page-title">Advanced</h1>
              <p className="vesper-settings-page-description">Point the client at a different server environment.</p>
            </div>
          </div>

          <div className="vesper-settings-card">
            <label className="vesper-settings-field">
              <span className="vesper-settings-label">Server URL</span>
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

            <p className="vesper-settings-helper">Changes apply after the next reconnect.</p>

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
            <div className="vesper-settings-note-pill">
              <Palette className="w-4 h-4" />
              <span>This is best for local development or alternate self-hosted targets.</span>
            </div>
          </div>
        </>
      )}
    </SettingsShell>
  )
}
