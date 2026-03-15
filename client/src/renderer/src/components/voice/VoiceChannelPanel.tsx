import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Headphones,
  HeadphoneOff,
  Mic,
  MicOff,
  PhoneOff,
  ScreenShare,
  ScreenShareOff,
  Video,
  VideoOff,
  Volume2
} from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import { useServerStore } from '../../stores/serverStore'
import { useVoiceStore, type VoiceParticipant } from '../../stores/voiceStore'
import type { VideoPublishProfile } from '../../voice/webrtc'
import Avatar from '../ui/Avatar'

type CameraPresetId = 'camera_balanced' | 'camera_crisp' | 'custom'
type SharePresetId = 'screen_low' | 'screen_balanced' | 'screen_crisp' | 'custom'
type StreamSlot = 'camera_video' | 'share_video'

interface CustomProfileState {
  width: number
  height: number
  frameRate: number
  bitrateKbps: number
}

interface StreamCard {
  key: string
  userId: string
  displayName: string
  avatarUrl: string | null
  stream: MediaStream
  slot: StreamSlot
  isLocal: boolean
  speaking: boolean
  muted: boolean
  hasShareAudio: boolean
}

interface ParticipantCard {
  id: string
  displayName: string
  avatarUrl: string | null
  speaking: boolean
  muted: boolean
  isLocal: boolean
  hasCamera: boolean
  hasShare: boolean
  hasShareAudio: boolean
  focusStreamKey: string | null
}

const CAMERA_PRESETS: Record<Exclude<CameraPresetId, 'custom'>, VideoPublishProfile> = {
  camera_balanced: {
    width: 1280,
    height: 720,
    frameRate: 30,
    bitrateKbps: 2500,
    contentHint: 'motion'
  },
  camera_crisp: {
    width: 1920,
    height: 1080,
    frameRate: 30,
    bitrateKbps: 5000,
    contentHint: 'motion'
  }
}

const SHARE_PRESETS: Record<Exclude<SharePresetId, 'custom'>, VideoPublishProfile> = {
  screen_low: {
    width: 1280,
    height: 720,
    frameRate: 15,
    bitrateKbps: 1500,
    contentHint: 'detail'
  },
  screen_balanced: {
    width: 1920,
    height: 1080,
    frameRate: 30,
    bitrateKbps: 4000,
    contentHint: 'detail'
  },
  screen_crisp: {
    width: 2560,
    height: 1440,
    frameRate: 30,
    bitrateKbps: 8000,
    contentHint: 'detail'
  }
}

function buildCustomProfile(
  custom: CustomProfileState,
  contentHint: VideoPublishProfile['contentHint']
): VideoPublishProfile {
  return {
    width: custom.width,
    height: custom.height,
    frameRate: custom.frameRate,
    bitrateKbps: custom.bitrateKbps,
    contentHint
  }
}

function resolveCameraProfile(
  preset: CameraPresetId,
  custom: CustomProfileState
): VideoPublishProfile {
  if (preset === 'custom') {
    return buildCustomProfile(custom, 'motion')
  }

  return CAMERA_PRESETS[preset]
}

function resolveShareProfile(
  preset: SharePresetId,
  custom: CustomProfileState
): VideoPublishProfile {
  if (preset === 'custom') {
    return buildCustomProfile(custom, 'detail')
  }

  return SHARE_PRESETS[preset]
}

function formatProfile(profile: VideoPublishProfile): string {
  return `${profile.width}x${profile.height} · ${profile.frameRate} fps · ${profile.bitrateKbps} kbps`
}

function getInitials(displayName: string): string {
  return displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?'
}

function VoiceVideoSurface({
  stream,
  muted = false,
  className,
  displayName,
  avatarUrl,
  mirror = false,
  fit = 'cover'
}: {
  stream: MediaStream
  muted?: boolean
  className?: string
  displayName: string
  avatarUrl: string | null
  mirror?: boolean
  fit?: 'cover' | 'contain'
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!videoRef.current) {
      return
    }

    if (videoRef.current.srcObject !== stream) {
      videoRef.current.srcObject = stream
    }
    setReady(false)

    return () => {
      if (videoRef.current) {
        videoRef.current.srcObject = null
      }
    }
  }, [stream])

  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?'

  return (
    <div className="vesper-voice-video-surface">
      {!ready && (
        <div className="vesper-voice-video-surface-overlay">
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="vesper-voice-video-surface-preview" />
          ) : null}
          <div className="vesper-voice-video-surface-fallback">{initials}</div>
        </div>
      )}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        onLoadedData={() => setReady(true)}
        className={`${className ?? ''} ${mirror ? 'vesper-voice-video-surface-mirror' : ''} ${fit === 'contain' ? 'vesper-voice-video-surface-contain' : ''}`.trim()}
      />
    </div>
  )
}

export default function VoiceChannelPanel(): React.JSX.Element | null {
  const activeServer = useServerStore((s) => s.servers.find((server) => server.id === s.activeServerId))
  const activeChannel = useServerStore((s) => {
    const server = s.servers.find((entry) => entry.id === s.activeServerId)
    return server?.channels.find((channel) => channel.id === s.activeChannelId)
  })
  const members = useServerStore((s) => s.members)
  const roomId = useVoiceStore((s) => s.roomId)
  const roomType = useVoiceStore((s) => s.roomType)
  const voiceState = useVoiceStore((s) => s.state)
  const participants = useVoiceStore((s) => s.participants)
  const remoteVolumes = useVoiceStore((s) => s.remoteVolumes)
  const remoteStreamVolumes = useVoiceStore((s) => s.remoteStreamVolumes)
  const connectionQuality = useVoiceStore((s) => s.connectionQuality)
  const roundTripMs = useVoiceStore((s) => s.roundTripMs)
  const packetLossPct = useVoiceStore((s) => s.packetLossPct)
  const jitterMs = useVoiceStore((s) => s.jitterMs)
  const inboundBitrateKbps = useVoiceStore((s) => s.inboundBitrateKbps)
  const outboundBitrateKbps = useVoiceStore((s) => s.outboundBitrateKbps)
  const errorMessage = useVoiceStore((s) => s.errorMessage)
  const muted = useVoiceStore((s) => s.muted)
  const deafened = useVoiceStore((s) => s.deafened)
  const cameraEnabled = useVoiceStore((s) => s.cameraEnabled)
  const screenShareEnabled = useVoiceStore((s) => s.screenShareEnabled)
  const localCameraStream = useVoiceStore((s) => s.localCameraStream)
  const localShareStream = useVoiceStore((s) => s.localShareStream)
  const remoteMediaStreams = useVoiceStore((s) => s.remoteMediaStreams)
  const shareAudioPreferred = useVoiceStore((s) => s.shareAudioPreferred)
  const encryptedMediaSupported = useVoiceStore((s) => s.encryptedMediaSupported)
  const setRemoteVolume = useVoiceStore((s) => s.setRemoteVolume)
  const setRemoteStreamVolume = useVoiceStore((s) => s.setRemoteStreamVolume)
  const setShareAudioPreferred = useVoiceStore((s) => s.setShareAudioPreferred)
  const toggleMute = useVoiceStore((s) => s.toggleMute)
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen)
  const toggleCamera = useVoiceStore((s) => s.toggleCamera)
  const toggleScreenShare = useVoiceStore((s) => s.toggleScreenShare)
  const joinVoiceChannel = useVoiceStore((s) => s.joinVoiceChannel)
  const disconnect = useVoiceStore((s) => s.disconnect)
  const myUserId = useAuthStore((s) => s.user?.id ?? null)
  const [cameraPreset, setCameraPreset] = useState<CameraPresetId>('camera_balanced')
  const [sharePreset, setSharePreset] = useState<SharePresetId>('screen_balanced')
  const [cameraCustom, setCameraCustom] = useState<CustomProfileState>({
    width: 1920,
    height: 1080,
    frameRate: 30,
    bitrateKbps: 5000
  })
  const [shareCustom, setShareCustom] = useState<CustomProfileState>({
    width: 1920,
    height: 1080,
    frameRate: 30,
    bitrateKbps: 4000
  })
  const [focusedStreamKey, setFocusedStreamKey] = useState<string | null>(null)

  if (!activeChannel || activeChannel.type !== 'voice') {
    return null
  }

  const isConnected =
    roomType === 'channel' &&
    roomId === activeChannel.id &&
    (voiceState === 'connected' || voiceState === 'in_call')
  const isConnecting = roomType === 'channel' && roomId === activeChannel.id && voiceState === 'connecting'
  const cameraProfile = resolveCameraProfile(cameraPreset, cameraCustom)
  const shareProfile = resolveShareProfile(sharePreset, shareCustom)
  const connectionQualityLabel = {
    good: 'Good',
    fair: 'Fair',
    poor: 'Poor',
    unknown: 'No Data'
  }[connectionQuality]

  const formatMetric = (value: number | null, suffix: string): string =>
    value === null || !Number.isFinite(value) ? 'n/a' : `${Math.round(value)}${suffix}`

  const formatLoss = (value: number | null): string =>
    value === null || !Number.isFinite(value) ? 'n/a' : `${value.toFixed(value >= 10 ? 0 : 1)}%`

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

  const participantCards = useMemo<ParticipantCard[]>(() => participants.map((participant) => {
    const member = members.find((entry) => entry.user_id === participant.user_id)
    const displayName = member?.user.display_name || member?.user.username || participant.user_id.slice(0, 8)
    const isLocal = participant.user_id === myUserId
    const hasCamera = isLocal
      ? Boolean(localCameraStream || participant.camera_video_track_id)
      : Boolean(participant.camera_video_track_id)
    const hasShare = isLocal
      ? Boolean(localShareStream || participant.share_video_track_id)
      : Boolean(participant.share_video_track_id)
    const hasShareAudio = isLocal
      ? Boolean(participant.share_audio_track_id || (localShareStream && shareAudioPreferred))
      : Boolean(participant.share_audio_track_id)

    return {
      id: participant.user_id,
      displayName,
      avatarUrl: member?.user.avatar_url ?? null,
      speaking: participant.speaking ?? false,
      muted: participant.muted,
      isLocal,
      hasCamera,
      hasShare,
      hasShareAudio,
      focusStreamKey: hasShare
        ? `${participant.user_id}:share_video`
        : hasCamera
          ? `${participant.user_id}:camera_video`
          : null
    }
  }), [localCameraStream, localShareStream, members, myUserId, participants, shareAudioPreferred])

  const streamCards = useMemo<StreamCard[]>(() => {
    const cards: StreamCard[] = []

    const pushCard = (
      userId: string,
      slot: StreamSlot,
      stream: MediaStream,
      isLocal: boolean
    ): void => {
      const member = members.find((entry) => entry.user_id === userId)
      const participant = participants.find((entry) => entry.user_id === userId)
      cards.push({
        key: `${userId}:${slot}`,
        userId,
        displayName: member?.user.display_name || member?.user.username || userId.slice(0, 8),
        avatarUrl: member?.user.avatar_url ?? null,
        stream,
        slot,
        isLocal,
        speaking: participant?.speaking ?? false,
        muted: participant?.muted ?? false,
        hasShareAudio: Boolean(participant?.share_audio_track_id)
      })
    }

    if (myUserId && localShareStream) {
      pushCard(myUserId, 'share_video', localShareStream, true)
    }

    if (myUserId && localCameraStream) {
      pushCard(myUserId, 'camera_video', localCameraStream, true)
    }

    for (const [key, stream] of Object.entries(remoteMediaStreams)) {
      const [userId, rawSlot] = key.split(':')
      if ((rawSlot === 'camera_video' || rawSlot === 'share_video') && userId) {
        pushCard(userId, rawSlot, stream, false)
      }
    }

    return cards
  }, [localCameraStream, localShareStream, members, myUserId, participants, remoteMediaStreams])

  const orderedStreamCards = useMemo(() => {
    const shares = streamCards.filter((card) => card.slot === 'share_video')
    const cameras = streamCards.filter((card) => card.slot === 'camera_video')
    return [...shares, ...cameras]
  }, [streamCards])

  useEffect(() => {
    if (!focusedStreamKey) {
      setFocusedStreamKey(orderedStreamCards[0]?.key ?? null)
      return
    }

    if (!orderedStreamCards.some((card) => card.key === focusedStreamKey)) {
      setFocusedStreamKey(orderedStreamCards[0]?.key ?? null)
    }
  }, [focusedStreamKey, orderedStreamCards])

  const focusedStream = orderedStreamCards.find((card) => card.key === focusedStreamKey) ?? null

  const applyLiveCameraProfile = async (): Promise<void> => {
    if (!cameraEnabled) {
      return
    }

    await toggleCamera()
    await toggleCamera(cameraProfile)
  }

  const applyLiveShareProfile = async (): Promise<void> => {
    if (!screenShareEnabled) {
      return
    }

    await toggleScreenShare()
    await toggleScreenShare(shareProfile, shareAudioPreferred)
  }

  return (
    <div className="vesper-voice-room">
      <div className="vesper-voice-room-hero">
        <div className="vesper-voice-room-hero-copy">
          <div className="vesper-voice-room-kicker">{activeServer?.name || 'Server Voice'}</div>
          <h2 className="vesper-voice-room-title">{activeChannel.name}</h2>
          <p className="vesper-voice-room-description">
            {isConnected
              ? 'Mic, camera, screen share, and share audio are relayed as encrypted RTP. Pick a profile, focus the stage, and tune each stream separately.'
              : 'Join this voice room to talk live, turn on your camera, or present your screen with encrypted transport.'}
          </p>
          <div className="vesper-voice-room-health">
            <span className={`vesper-voice-room-quality vesper-voice-room-quality-${connectionQuality}`}>
              {connectionQualityLabel}
            </span>
            <span>RTT {formatMetric(roundTripMs, 'ms')}</span>
            <span>Loss {formatLoss(packetLossPct)}</span>
            <span>Jitter {formatMetric(jitterMs, 'ms')}</span>
          </div>
          <div className="vesper-voice-room-transport">
            <span className="vesper-voice-room-transport-chip">
              <span className="vesper-voice-room-transport-label">In</span>
              <span>{formatBitrate(inboundBitrateKbps)}</span>
            </span>
            <span className="vesper-voice-room-transport-chip">
              <span className="vesper-voice-room-transport-label">Out</span>
              <span>{formatBitrate(outboundBitrateKbps)}</span>
            </span>
          </div>
          {!encryptedMediaSupported && (
            <div className="vesper-voice-room-error">
              Encrypted stream publishing and playback require a Chromium-class browser or the desktop app.
            </div>
          )}
          {errorMessage && <div className="vesper-voice-room-error">{errorMessage}</div>}
        </div>

        <div className="vesper-voice-room-actions">
          {isConnected ? (
            <>
              <button
                type="button"
                onClick={toggleMute}
                className={`vesper-voice-room-button${muted ? ' vesper-voice-room-button-danger' : ''}`}
              >
                {muted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                {muted ? 'Unmute' : 'Mute'}
              </button>
              <button
                type="button"
                onClick={toggleDeafen}
                className={`vesper-voice-room-button${deafened ? ' vesper-voice-room-button-danger' : ''}`}
              >
                {deafened ? <HeadphoneOff className="w-4 h-4" /> : <Headphones className="w-4 h-4" />}
                {deafened ? 'Undeafen' : 'Deafen'}
              </button>
              <button
                type="button"
                onClick={() => {
                  void toggleCamera(cameraProfile)
                }}
                className={`vesper-voice-room-button${cameraEnabled ? ' vesper-voice-room-button-active' : ''}`}
              >
                {cameraEnabled ? <VideoOff className="w-4 h-4" /> : <Video className="w-4 h-4" />}
                {cameraEnabled ? 'Stop Camera' : 'Camera'}
              </button>
              <button
                type="button"
                onClick={() => {
                  void toggleScreenShare(shareProfile, shareAudioPreferred)
                }}
                className={`vesper-voice-room-button${screenShareEnabled ? ' vesper-voice-room-button-active' : ''}`}
              >
                {screenShareEnabled ? <ScreenShareOff className="w-4 h-4" /> : <ScreenShare className="w-4 h-4" />}
                {screenShareEnabled ? 'Stop Share' : 'Share Screen'}
              </button>
              <button
                type="button"
                onClick={disconnect}
                className="vesper-voice-room-button vesper-voice-room-button-danger"
              >
                <PhoneOff className="w-4 h-4" />
                Disconnect
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                void joinVoiceChannel(activeChannel.id)
              }}
              disabled={isConnecting}
              className="vesper-voice-room-button vesper-voice-room-button-primary"
            >
              <Volume2 className="w-4 h-4" />
              {isConnecting ? 'Connecting...' : 'Join Voice'}
            </button>
          )}
        </div>
      </div>

      {participantCards.length > 0 && (
        <section className="vesper-voice-room-presence-strip">
          <div className="vesper-voice-room-section-header">
            <div className="vesper-voice-room-section-title">People Here</div>
            <div className="vesper-voice-room-section-meta">
              {participantCards.length} connected
            </div>
          </div>

          <div className="vesper-voice-room-presence-grid">
            {participantCards.map((participant) => (
              <VoicePresenceTile
                key={participant.id}
                participant={participant}
                active={participant.focusStreamKey !== null && participant.focusStreamKey === focusedStreamKey}
                onSelect={() => {
                  if (participant.focusStreamKey) {
                    setFocusedStreamKey(participant.focusStreamKey)
                  }
                }}
              />
            ))}
          </div>
        </section>
      )}

      <div className="vesper-voice-room-publish-grid">
        <ProfileCard
          title="Camera Profile"
          description={formatProfile(cameraProfile)}
          active={cameraEnabled}
          onApply={() => {
            void applyLiveCameraProfile()
          }}
        >
          <label className="vesper-voice-profile-field">
            <span>Preset</span>
            <select
              value={cameraPreset}
              onChange={(event) => setCameraPreset(event.target.value as CameraPresetId)}
              className="vesper-voice-profile-select"
            >
              <option value="camera_balanced">Balanced</option>
              <option value="camera_crisp">Crisp</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          {cameraPreset === 'custom' && (
            <CustomProfileFields
              value={cameraCustom}
              onChange={setCameraCustom}
            />
          )}
        </ProfileCard>

        <ProfileCard
          title="Share Profile"
          description={formatProfile(shareProfile)}
          active={screenShareEnabled}
          onApply={() => {
            void applyLiveShareProfile()
          }}
        >
          <label className="vesper-voice-profile-field">
            <span>Preset</span>
            <select
              value={sharePreset}
              onChange={(event) => setSharePreset(event.target.value as SharePresetId)}
              className="vesper-voice-profile-select"
            >
              <option value="screen_low">Low</option>
              <option value="screen_balanced">Balanced</option>
              <option value="screen_crisp">Crisp</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <label className="vesper-voice-profile-toggle">
            <input
              type="checkbox"
              checked={shareAudioPreferred}
              onChange={(event) => setShareAudioPreferred(event.target.checked)}
            />
            <span>Capture share audio when supported</span>
          </label>
          {sharePreset === 'custom' && (
            <CustomProfileFields
              value={shareCustom}
              onChange={setShareCustom}
            />
          )}
        </ProfileCard>
      </div>

      <div className="vesper-voice-room-stage-layout">
        <div className="vesper-voice-room-stage">
          {focusedStream ? (
            <>
              <div className="vesper-voice-room-stage-header">
                <div>
                  <div className="vesper-voice-room-featured-kicker">
                    {focusedStream.slot === 'share_video' ? 'Screen Share' : 'Camera Feed'}
                  </div>
                  <div className="vesper-voice-room-featured-name">{focusedStream.displayName}</div>
                  <div className="vesper-voice-room-featured-meta">
                    {focusedStream.isLocal
                      ? focusedStream.slot === 'share_video'
                        ? 'You are presenting live'
                        : 'Your camera is live'
                      : focusedStream.hasShareAudio && focusedStream.slot === 'share_video'
                        ? 'Encrypted share with separate stream audio'
                        : 'Encrypted live video relay'}
                  </div>
                </div>
                {!focusedStream.isLocal && focusedStream.slot === 'share_video' && focusedStream.hasShareAudio && (
                  <label className="vesper-voice-room-stage-slider">
                    <span>Stream audio</span>
                    <input
                      type="range"
                      min={0}
                      max={200}
                      step={1}
                      value={remoteStreamVolumes[focusedStream.userId] ?? 100}
                      onChange={(event) => setRemoteStreamVolume(focusedStream.userId, Number(event.target.value))}
                    />
                  </label>
                )}
              </div>
              <VoiceVideoSurface
                stream={focusedStream.stream}
                muted={focusedStream.isLocal}
                displayName={focusedStream.displayName}
                avatarUrl={focusedStream.avatarUrl}
                mirror={focusedStream.isLocal && focusedStream.slot === 'camera_video'}
                fit={focusedStream.slot === 'share_video' ? 'contain' : 'cover'}
                className="vesper-voice-room-stage-video"
              />
            </>
          ) : (
            <div className="vesper-voice-room-empty">
              <Volume2 className="w-7 h-7" />
              <p>No streams are live yet.</p>
              <span>Voice can stay live on its own, or someone can turn on a camera or share a screen.</span>
            </div>
          )}
        </div>

        <aside className="vesper-voice-room-streams">
          <div className="vesper-voice-room-streams-title">Live Streams</div>
          {orderedStreamCards.length > 0 ? (
            orderedStreamCards.map((card) => (
              <button
                key={card.key}
                type="button"
                className={card.key === focusedStreamKey ? 'vesper-voice-room-stream-card vesper-voice-room-stream-card-active' : 'vesper-voice-room-stream-card'}
                onClick={() => setFocusedStreamKey(card.key)}
              >
                <div className="vesper-voice-room-stream-card-media">
                  <div className="vesper-voice-room-stream-card-badges">
                    <span className="vesper-voice-room-stream-badge">
                      {card.slot === 'share_video' ? 'Share' : 'Camera'}
                    </span>
                    {card.isLocal && <span className="vesper-voice-room-stream-badge">You</span>}
                  </div>
                  <VoiceVideoSurface
                    stream={card.stream}
                    muted={card.isLocal}
                    displayName={card.displayName}
                    avatarUrl={card.avatarUrl}
                    mirror={card.isLocal && card.slot === 'camera_video'}
                    className="vesper-voice-room-stream-card-video"
                  />
                </div>
                <div className="vesper-voice-room-stream-card-copy">
                  <span>{card.displayName}</span>
                  <span>
                    {card.slot === 'share_video' ? 'Screen share' : 'Camera'}
                    {card.hasShareAudio && card.slot === 'share_video' ? ' · Audio' : ''}
                    {card.speaking && card.slot === 'camera_video' ? ' · Speaking' : ''}
                  </span>
                </div>
              </button>
            ))
          ) : (
            <div className="vesper-voice-room-streams-empty">No camera or share feeds yet.</div>
          )}
        </aside>
      </div>

      <div className="vesper-voice-room-roster">
        {participantCards.length > 0 ? (
          participantCards.map((participant) => (
            <ParticipantAudioCard
              key={participant.id}
              participant={participant}
              voiceVolume={remoteVolumes[participant.id] ?? 100}
              streamVolume={remoteStreamVolumes[participant.id] ?? 100}
              onVoiceVolumeChange={(volume) => setRemoteVolume(participant.id, volume)}
              onStreamVolumeChange={(volume) => setRemoteStreamVolume(participant.id, volume)}
            />
          ))
        ) : (
          <div className="vesper-voice-room-empty">
            <Volume2 className="w-7 h-7" />
            <p>No one is in here yet.</p>
            <span>Start the channel and Vesper will keep the call encrypted end to end.</span>
          </div>
        )}
      </div>
    </div>
  )
}

function ProfileCard({
  title,
  description,
  active,
  onApply,
  children
}: {
  title: string
  description: string
  active: boolean
  onApply: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="vesper-voice-profile-card">
      <div className="vesper-voice-profile-header">
        <div>
          <div className="vesper-voice-profile-title">{title}</div>
          <div className="vesper-voice-profile-description">{description}</div>
        </div>
        {active && (
          <button
            type="button"
            className="vesper-voice-profile-apply"
            onClick={onApply}
          >
            Apply Live
          </button>
        )}
      </div>
      <div className="vesper-voice-profile-body">
        {children}
      </div>
    </section>
  )
}

function CustomProfileFields({
  value,
  onChange
}: {
  value: CustomProfileState
  onChange: (value: CustomProfileState) => void
}): React.JSX.Element {
  return (
    <div className="vesper-voice-profile-grid">
      <label className="vesper-voice-profile-field">
        <span>Width</span>
        <input
          type="number"
          min={640}
          max={3840}
          value={value.width}
          onChange={(event) => onChange({ ...value, width: Number(event.target.value) })}
          className="vesper-voice-profile-input"
        />
      </label>
      <label className="vesper-voice-profile-field">
        <span>Height</span>
        <input
          type="number"
          min={360}
          max={2160}
          value={value.height}
          onChange={(event) => onChange({ ...value, height: Number(event.target.value) })}
          className="vesper-voice-profile-input"
        />
      </label>
      <label className="vesper-voice-profile-field">
        <span>FPS</span>
        <input
          type="number"
          min={10}
          max={60}
          value={value.frameRate}
          onChange={(event) => onChange({ ...value, frameRate: Number(event.target.value) })}
          className="vesper-voice-profile-input"
        />
      </label>
      <label className="vesper-voice-profile-field">
        <span>Bitrate</span>
        <input
          type="number"
          min={500}
          max={12000}
          step={100}
          value={value.bitrateKbps}
          onChange={(event) => onChange({ ...value, bitrateKbps: Number(event.target.value) })}
          className="vesper-voice-profile-input"
        />
      </label>
    </div>
  )
}

function ParticipantAudioCard({
  participant,
  voiceVolume,
  streamVolume,
  onVoiceVolumeChange,
  onStreamVolumeChange
}: {
  participant: {
    id: string
    displayName: string
    avatarUrl: string | null
    speaking: boolean
    muted: boolean
    isLocal: boolean
    hasCamera: boolean
    hasShare: boolean
    hasShareAudio: boolean
  }
  voiceVolume: number
  streamVolume: number
  onVoiceVolumeChange: (volume: number) => void
  onStreamVolumeChange: (volume: number) => void
}): React.JSX.Element {
  return (
    <div className="vesper-voice-roster-card">
      <div className="vesper-voice-roster-card-top">
        <div className="vesper-voice-roster-card-user">
          <Avatar
            userId={participant.id}
            avatarUrl={participant.avatarUrl}
            displayName={participant.displayName}
            size="sm"
            speaking={participant.speaking}
          />
          <div>
            <div className="vesper-voice-roster-card-name">{participant.displayName}</div>
            <div className="vesper-voice-roster-card-meta">
              {participant.muted ? 'Muted' : participant.speaking ? 'Speaking' : 'Listening'}
            </div>
          </div>
        </div>
        <div className="vesper-voice-roster-card-badges">
          {participant.hasCamera && <span className="vesper-voice-roster-badge">Camera</span>}
          {participant.hasShare && <span className="vesper-voice-roster-badge">Share</span>}
          {participant.hasShareAudio && <span className="vesper-voice-roster-badge">Share Audio</span>}
        </div>
      </div>

      {!participant.isLocal && (
        <div className="vesper-voice-roster-sliders">
          <label className="vesper-voice-room-volume">
            <span>Voice</span>
            <input
              type="range"
              min={0}
              max={200}
              step={1}
              value={voiceVolume}
              onChange={(event) => onVoiceVolumeChange(Number(event.target.value))}
            />
          </label>
          {participant.hasShareAudio && (
            <label className="vesper-voice-room-volume">
              <span>Stream</span>
              <input
                type="range"
                min={0}
                max={200}
                step={1}
                value={streamVolume}
                onChange={(event) => onStreamVolumeChange(Number(event.target.value))}
              />
            </label>
          )}
        </div>
      )}
    </div>
  )
}

function VoicePresenceTile({
  participant,
  active,
  onSelect
}: {
  participant: ParticipantCard
  active: boolean
  onSelect: () => void
}): React.JSX.Element {
  const initials = getInitials(participant.displayName)

  return (
    <button
      type="button"
      className={
        active
          ? 'vesper-voice-presence-tile vesper-voice-presence-tile-active'
          : 'vesper-voice-presence-tile'
      }
      onClick={onSelect}
      disabled={!participant.focusStreamKey}
      title={
        participant.focusStreamKey
          ? `Focus ${participant.displayName}`
          : `${participant.displayName} is audio only`
      }
    >
      <div className="vesper-voice-presence-avatar-shell">
        <div className={participant.speaking ? 'vesper-voice-presence-avatar-ring vesper-voice-presence-avatar-ring-speaking' : 'vesper-voice-presence-avatar-ring'}>
          <div className={participant.speaking ? 'vesper-voice-presence-avatar vesper-voice-presence-avatar-speaking' : 'vesper-voice-presence-avatar'}>
            {participant.avatarUrl ? (
              <img src={participant.avatarUrl} alt="" className="vesper-voice-presence-avatar-image" />
            ) : (
              <span className="vesper-voice-presence-avatar-fallback">{initials}</span>
            )}
          </div>
        </div>
        {participant.muted && (
          <span className="vesper-voice-presence-status-badge" aria-label="Muted">
            <MicOff className="w-3 h-3" />
          </span>
        )}
        {participant.hasShare && (
          <span className="vesper-voice-presence-live-badge">Live</span>
        )}
      </div>

      <div className="vesper-voice-presence-name">
        {participant.displayName}
        {participant.isLocal ? ' (You)' : ''}
      </div>
      <div className="vesper-voice-presence-meta">
        {participant.hasShare
          ? 'Screen share'
          : participant.hasCamera
            ? 'Camera live'
            : participant.speaking
              ? 'Speaking'
              : 'Audio only'}
      </div>
    </button>
  )
}
