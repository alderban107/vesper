import { useEffect, useMemo, useRef, useState } from 'react'
import {
  HeadphoneOff,
  Headphones,
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
import { useVoiceStore } from '../../stores/voiceStore'
import type { VideoPublishProfile } from '../../voice/webrtc'
import Avatar from '../ui/Avatar'
import VoiceVideoSurface, {
  getCallGridClass,
  getInitials,
  type StreamCard,
  type ParticipantCard,
  type StreamSlot
} from './VoiceVideoSurface'

type CameraPresetId = 'camera_balanced' | 'camera_crisp' | 'custom'
type SharePresetId = 'screen_low' | 'screen_balanced' | 'screen_crisp' | 'custom'

interface CustomProfileState {
  width: number
  height: number
  frameRate: number
  bitrateKbps: number
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

export default function VoiceChannelPanel(): React.JSX.Element | null {
  const activeServer = useServerStore((s) =>
    s.servers.find((server) => server.id === s.activeServerId)
  )
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
  const isConnecting =
    roomType === 'channel' && roomId === activeChannel.id && voiceState === 'connecting'
  const cameraProfile = resolveCameraProfile(cameraPreset, cameraCustom)
  const shareProfile = resolveShareProfile(sharePreset, shareCustom)
  const connectionQualityLabel = {
    good: 'Good',
    fair: 'Fair',
    poor: 'Poor',
    unknown: 'No data'
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

  const participantCards = useMemo<ParticipantCard[]>(
    () =>
      participants.map((participant) => {
        const member = members.find((entry) => entry.user_id === participant.user_id)
        const displayName =
          member?.user.display_name || member?.user.username || participant.user_id.slice(0, 8)
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
          hasShareAudio
        }
      }),
    [localCameraStream, localShareStream, members, myUserId, participants, shareAudioPreferred]
  )

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
      const displayName = member?.user.display_name || member?.user.username || userId.slice(0, 8)
      let testId: string | undefined
      if (isLocal) {
        testId = 'local-video'
      } else if (slot === 'share_video') {
        testId = 'remote-screen-share'
      } else {
        testId = `remote-video-${displayName}`
      }

      cards.push({
        key: `${userId}:${slot}`,
        userId,
        displayName,
        avatarUrl: member?.user.avatar_url ?? null,
        stream,
        slot,
        isLocal,
        speaking: participant?.speaking ?? false,
        muted: participant?.muted ?? false,
        hasShareAudio: Boolean(participant?.share_audio_track_id),
        testId
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

  const voiceOnlyParticipants = participantCards.filter(
    (participant) => !participant.hasCamera && !participant.hasShare
  )

  useEffect(() => {
    if (!orderedStreamCards.length) {
      setFocusedStreamKey(null)
      return
    }

    if (!focusedStreamKey || !orderedStreamCards.some((card) => card.key === focusedStreamKey)) {
      setFocusedStreamKey(orderedStreamCards[0]?.key ?? null)
    }
  }, [focusedStreamKey, orderedStreamCards])

  const focusedStream =
    orderedStreamCards.find((card) => card.key === focusedStreamKey) ?? orderedStreamCards[0] ?? null

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
    <div data-testid="voice-channel-panel" className="vesper-voice-room vesper-voice-room-discord">
      <div className="vesper-voice-room-discord-layout vesper-voice-room-discord-layout-simple">
        <div className="vesper-voice-room-discord-main">
          <section className="vesper-voice-room-discord-surface">
            <div className="vesper-voice-room-discord-surface-header">
              <div>
                <div className="vesper-voice-room-kicker">{activeServer?.name || 'Server voice'}</div>
                <h2 className="vesper-voice-room-title">{activeChannel.name}</h2>
              </div>
              <div className="vesper-voice-room-section-meta">{participantCards.length} in voice</div>
            </div>

            {orderedStreamCards.length > 0 ? (
              <div
                className={`vesper-voice-call-grid ${getCallGridClass(orderedStreamCards.length)}`}
              >
                {orderedStreamCards.map((card) => (
                  <VoiceVideoTile
                    key={card.key}
                    card={card}
                    active={card.key === focusedStream?.key}
                    onSelect={() => setFocusedStreamKey(card.key)}
                  />
                ))}
              </div>
            ) : participantCards.length > 0 ? (
              <div className={`vesper-voice-avatar-grid ${getCallGridClass(participantCards.length)}`}>
                {participantCards.map((participant) => (
                  <VoiceAvatarTile key={participant.id} participant={participant} />
                ))}
              </div>
            ) : (
              <div className="vesper-voice-room-empty">
                <Volume2 className="w-7 h-7" />
                <p>No one is in here yet.</p>
                <span>Join the channel to start the call.</span>
              </div>
            )}

            {voiceOnlyParticipants.length > 0 && orderedStreamCards.length > 0 && (
              <div className="vesper-voice-room-discord-audio-strip">
                <div className="vesper-voice-room-discord-audio-list">
                  {voiceOnlyParticipants.map((participant) => (
                    <VoiceMiniPresence key={participant.id} participant={participant} />
                  ))}
                </div>
              </div>
            )}

            <div
              className="vesper-voice-room-discord-status"
              data-testid={isConnected ? 'voice-connected' : undefined}
            >
              <span
                className={`vesper-call-overlay-status-dot vesper-voice-room-discord-status-dot vesper-call-overlay-quality-${connectionQuality}`}
                aria-hidden="true"
              />
              <div className="vesper-voice-room-discord-status-copy">
                <span className="vesper-voice-room-discord-status-label">
                  {isConnected ? 'Voice connected' : isConnecting ? 'Connecting...' : 'Not connected'}
                </span>
                <span className="vesper-voice-room-discord-status-meta">
                  {connectionQuality === 'unknown' ? activeChannel.name : `${activeChannel.name} · ${connectionQualityLabel}`}
                </span>
              </div>
            </div>

            {!encryptedMediaSupported && (
              <div className="vesper-voice-room-error">
                Encrypted stream publishing and playback require a Chromium-class browser or the desktop app.
              </div>
            )}
            {errorMessage && <div className="vesper-voice-room-error">{errorMessage}</div>}

            <div className="vesper-voice-room-actions">
              {isConnected ? (
                <>
                  <button
                    data-testid="mute-button"
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
                    {deafened ? (
                      <HeadphoneOff className="w-4 h-4" />
                    ) : (
                      <Headphones className="w-4 h-4" />
                    )}
                    {deafened ? 'Undeafen' : 'Deafen'}
                  </button>
                  <button
                    data-testid="camera-button"
                    type="button"
                    onClick={() => {
                      void toggleCamera(cameraProfile)
                    }}
                    className={`vesper-voice-room-button${cameraEnabled ? ' vesper-voice-room-button-active' : ''}`}
                  >
                    {cameraEnabled ? <VideoOff className="w-4 h-4" /> : <Video className="w-4 h-4" />}
                    {cameraEnabled ? 'Stop camera' : 'Camera'}
                  </button>
                  <button
                    data-testid="screen-share-button"
                    type="button"
                    onClick={() => {
                      void toggleScreenShare(shareProfile, shareAudioPreferred)
                    }}
                    className={`vesper-voice-room-button${screenShareEnabled ? ' vesper-voice-room-button-active' : ''}`}
                  >
                    {screenShareEnabled ? (
                      <ScreenShareOff className="w-4 h-4" />
                    ) : (
                      <ScreenShare className="w-4 h-4" />
                    )}
                    {screenShareEnabled ? 'Stop share' : 'Share'}
                  </button>
                  <button
                    data-testid="disconnect-call"
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
                  {isConnecting ? 'Connecting...' : 'Join voice'}
                </button>
              )}
            </div>

            {focusedStream &&
              !focusedStream.isLocal &&
              focusedStream.slot === 'share_video' &&
              focusedStream.hasShareAudio && (
                <label className="vesper-voice-room-volume">
                  <span>Share audio volume</span>
                  <input
                    type="range"
                    min={0}
                    max={200}
                    step={1}
                    value={remoteStreamVolumes[focusedStream.userId] ?? 100}
                    onChange={(event) =>
                      setRemoteStreamVolume(focusedStream.userId, Number(event.target.value))
                    }
                  />
                </label>
              )}
          </section>
        </div>
      </div>
    </div>
  )
}

function VoiceVideoTile({
  card,
  active,
  onSelect
}: {
  card: StreamCard
  active: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={
        active
          ? 'vesper-voice-call-tile vesper-voice-call-tile-active'
          : 'vesper-voice-call-tile'
      }
      onClick={onSelect}
    >
      <div className="vesper-voice-call-tile-media">
        <VoiceVideoSurface
          stream={card.stream}
          muted={card.isLocal}
          displayName={card.displayName}
          avatarUrl={card.avatarUrl}
          mirror={card.isLocal && card.slot === 'camera_video'}
          fit={card.slot === 'share_video' ? 'contain' : 'cover'}
          testId={card.testId}
          className="vesper-voice-call-tile-video"
        />
      </div>
      <div className="vesper-voice-call-tile-top">
        <div className="vesper-voice-call-tile-badges">
          <span className="vesper-voice-call-tile-badge">
            {card.slot === 'share_video' ? 'Screen' : 'Camera'}
          </span>
          {card.isLocal && <span className="vesper-voice-call-tile-badge">You</span>}
          {card.hasShareAudio && card.slot === 'share_video' && (
            <span className="vesper-voice-call-tile-badge">Audio</span>
          )}
        </div>
      </div>
      <div className="vesper-voice-call-tile-bottom">
        <span className="vesper-voice-call-tile-name">
          {card.muted && <MicOff className="w-3 h-3" />}
          {card.displayName}
        </span>
        <span className="vesper-voice-call-tile-meta">
          {card.slot === 'share_video'
            ? 'Presenting'
            : card.speaking
              ? 'Speaking'
              : card.muted
                ? 'Muted'
                : 'Live'}
        </span>
      </div>
    </button>
  )
}

function VoiceAvatarTile({
  participant
}: {
  participant: ParticipantCard
}): React.JSX.Element {
  const initials = getInitials(participant.displayName)

  return (
    <div
      className={
        participant.speaking
          ? 'vesper-voice-avatar-tile vesper-voice-avatar-tile-speaking'
          : 'vesper-voice-avatar-tile'
      }
    >
      <div className="vesper-voice-avatar-tile-shell">
        <div className="vesper-voice-avatar-tile-ring">
          <div className="vesper-voice-avatar-tile-avatar">
            {participant.avatarUrl ? (
              <img
                src={participant.avatarUrl}
                alt=""
                className="vesper-voice-avatar-tile-image"
              />
            ) : (
              <span className="vesper-voice-avatar-tile-fallback">{initials}</span>
            )}
          </div>
        </div>
        {participant.muted && (
          <span className="vesper-voice-avatar-tile-status">
            <MicOff className="w-3 h-3" />
          </span>
        )}
        {participant.hasShare && <span className="vesper-voice-avatar-tile-live">LIVE</span>}
      </div>
      <div data-testid="voice-participant-name" className="vesper-voice-avatar-tile-name">
        {participant.displayName}
        {participant.isLocal ? ' (You)' : ''}
      </div>
      <div className="vesper-voice-avatar-tile-meta">
        {participant.hasShare
          ? 'Sharing screen'
          : participant.hasCamera
            ? 'Camera on'
            : participant.speaking
              ? 'Speaking'
              : 'Listening'}
      </div>
    </div>
  )
}

function VoiceMiniPresence({
  participant
}: {
  participant: ParticipantCard
}): React.JSX.Element {
  return (
    <div className="vesper-call-overlay-presence-pill">
      <div className="vesper-call-overlay-presence-avatar">
        {participant.avatarUrl ? (
          <img
            src={participant.avatarUrl}
            alt=""
            className="vesper-call-overlay-presence-avatar-image"
          />
        ) : (
          <span className="vesper-call-overlay-presence-avatar-fallback">
            {getInitials(participant.displayName)}
          </span>
        )}
        {participant.muted && (
          <span className="vesper-call-overlay-presence-muted">
            <MicOff className="w-2.5 h-2.5" />
          </span>
        )}
      </div>
      <div className="vesper-call-overlay-presence-copy">
        <span className="vesper-call-overlay-presence-name">
          {participant.displayName}
          {participant.isLocal ? ' (You)' : ''}
        </span>
        <span className="vesper-call-overlay-presence-meta">
          {participant.speaking ? 'Speaking' : 'Audio'}
        </span>
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
          <button type="button" className="vesper-voice-profile-apply" onClick={onApply}>
            Apply live
          </button>
        )}
      </div>
      <div className="vesper-voice-profile-body">{children}</div>
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

function ParticipantAudioRow({
  participant,
  voiceVolume,
  streamVolume,
  onVoiceVolumeChange,
  onStreamVolumeChange
}: {
  participant: ParticipantCard
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
            <div data-testid="voice-participant-name" className="vesper-voice-roster-card-name">
              {participant.displayName}
              {participant.isLocal ? ' (You)' : ''}
            </div>
            <div className="vesper-voice-roster-card-meta">
              {participant.hasShare
                ? 'Screen share live'
                : participant.hasCamera
                  ? participant.speaking
                    ? 'Camera live · speaking'
                    : 'Camera live'
                  : participant.muted
                    ? 'Muted'
                    : participant.speaking
                      ? 'Speaking'
                      : 'Listening'}
            </div>
          </div>
        </div>
        <div className="vesper-voice-roster-card-badges">
          {participant.hasCamera && <span className="vesper-voice-roster-badge">Camera</span>}
          {participant.hasShare && <span className="vesper-voice-roster-badge">Share</span>}
          {participant.hasShareAudio && <span className="vesper-voice-roster-badge">Share audio</span>}
        </div>
      </div>

      {!participant.isLocal && (
        <div className="vesper-voice-roster-sliders">
          <label className="vesper-voice-room-volume">
            <span>Voice volume</span>
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
              <span>Share audio</span>
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
