import { useEffect, useRef, useState } from 'react'
import {
  HeadphoneOff,
  Headphones,
  Mic,
  MicOff,
  PhoneOff,
  ScreenShare,
  ScreenShareOff,
  Video,
  VideoOff
} from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import { useDmStore } from '../../stores/dmStore'
import { useServerStore } from '../../stores/serverStore'
import { useVoiceStore } from '../../stores/voiceStore'

interface OverlayEntry {
  id: string
  stream: MediaStream
  label: string
  kind: 'camera' | 'share'
  avatarUrl: string | null
  speaking: boolean
  participantMuted: boolean
  isLocal: boolean
  hasShareAudio: boolean
  testId?: string
}

function getInitials(label: string): string {
  return (
    label
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '?'
  )
}

function getOverlayGridClass(count: number): string {
  if (count <= 1) {
    return 'vesper-call-overlay-grid-single'
  }

  if (count === 2) {
    return 'vesper-call-overlay-grid-dual'
  }

  return 'vesper-call-overlay-grid-multi'
}

function OverlayVideoTile({
  stream,
  muted = false,
  label,
  kind,
  avatarUrl,
  mirror = false,
  speaking = false,
  participantMuted = false,
  isLocal = false,
  hasShareAudio = false,
  testId
}: {
  stream: MediaStream
  muted?: boolean
  label: string
  kind: 'camera' | 'share'
  avatarUrl: string | null
  mirror?: boolean
  speaking?: boolean
  participantMuted?: boolean
  isLocal?: boolean
  hasShareAudio?: boolean
  testId?: string
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [ready, setReady] = useState(false)
  const initials = getInitials(label)

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

  return (
    <div
      className={
        speaking
          ? 'vesper-call-overlay-tile vesper-call-overlay-tile-speaking'
          : 'vesper-call-overlay-tile'
      }
    >
      {!ready && (
        <div className="vesper-call-overlay-tile-loading">
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="vesper-call-overlay-tile-preview" />
          ) : null}
          <div className="vesper-call-overlay-tile-fallback">{initials}</div>
        </div>
      )}
      <video
        ref={videoRef}
        data-testid={testId}
        autoPlay
        playsInline
        muted={muted}
        onLoadedData={() => setReady(true)}
        className={`vesper-call-overlay-tile-video${mirror ? ' vesper-call-overlay-tile-video-mirror' : ''}`}
      />

      <div className="vesper-call-overlay-tile-top">
        <div className="vesper-call-overlay-tile-badges">
          <span className="vesper-call-overlay-tile-badge">
            {kind === 'share' ? 'Screen' : 'Video'}
          </span>
          {isLocal && <span className="vesper-call-overlay-tile-badge">You</span>}
          {hasShareAudio && kind === 'share' && (
            <span className="vesper-call-overlay-tile-badge">Audio</span>
          )}
        </div>
      </div>

      <div className="vesper-call-overlay-tile-bottom">
        <span className="vesper-call-overlay-tile-name">
          {participantMuted && <MicOff className="w-3 h-3" />}
          {label}
        </span>
        <span className="vesper-call-overlay-tile-state">
          {kind === 'share'
            ? 'Presenting'
            : speaking
              ? 'Speaking'
              : participantMuted
                ? 'Muted'
                : 'Live'}
        </span>
      </div>
    </div>
  )
}

export default function CallOverlay({
  mobileDocked = false
}: {
  mobileDocked?: boolean
} = {}): React.JSX.Element | null {
  const voiceState = useVoiceStore((s) => s.state)
  const roomId = useVoiceStore((s) => s.roomId)
  const roomType = useVoiceStore((s) => s.roomType)
  const participants = useVoiceStore((s) => s.participants)
  const muted = useVoiceStore((s) => s.muted)
  const deafened = useVoiceStore((s) => s.deafened)
  const voiceError = useVoiceStore((s) => s.errorMessage)
  const disconnect = useVoiceStore((s) => s.disconnect)
  const toggleMute = useVoiceStore((s) => s.toggleMute)
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen)
  const connectionQuality = useVoiceStore((s) => s.connectionQuality)
  const roundTripMs = useVoiceStore((s) => s.roundTripMs)
  const packetLossPct = useVoiceStore((s) => s.packetLossPct)
  const inboundBitrateKbps = useVoiceStore((s) => s.inboundBitrateKbps)
  const outboundBitrateKbps = useVoiceStore((s) => s.outboundBitrateKbps)
  const cameraEnabled = useVoiceStore((s) => s.cameraEnabled)
  const screenShareEnabled = useVoiceStore((s) => s.screenShareEnabled)
  const localCameraStream = useVoiceStore((s) => s.localCameraStream)
  const localShareStream = useVoiceStore((s) => s.localShareStream)
  const remoteMediaStreams = useVoiceStore((s) => s.remoteMediaStreams)
  const shareAudioPreferred = useVoiceStore((s) => s.shareAudioPreferred)
  const setShareAudioPreferred = useVoiceStore((s) => s.setShareAudioPreferred)
  const toggleCamera = useVoiceStore((s) => s.toggleCamera)
  const toggleScreenShare = useVoiceStore((s) => s.toggleScreenShare)
  const activeServer = useServerStore((s) => s.servers.find((server) => server.id === s.activeServerId))
  const members = useServerStore((s) => s.members)
  const conversations = useDmStore((s) => s.conversations)
  const currentUserId = useAuthStore((s) => s.user?.id ?? null)

  const [duration, setDuration] = useState(0)

  useEffect(() => {
    if (voiceState !== 'in_call' && voiceState !== 'connected') {
      setDuration(0)
      return
    }

    const interval = setInterval(() => {
      setDuration((value) => value + 1)
    }, 1000)

    return () => clearInterval(interval)
  }, [voiceState])

  if (voiceState === 'idle') {
    return null
  }

  const roomLabel =
    roomType === 'channel'
      ? activeServer?.channels.find((channel) => channel.id === roomId)?.name ?? 'Voice Channel'
      : conversations.find((conversation) => conversation.id === roomId)?.name ?? 'Direct Call'
  const activeConversation =
    roomType === 'dm'
      ? conversations.find((conversation) => conversation.id === roomId) ?? null
      : null

  const formatDuration = (seconds: number): string => {
    const minutes = Math.floor(seconds / 60)
    const remainder = seconds % 60
    return `${minutes}:${remainder.toString().padStart(2, '0')}`
  }

  const formatBitrate = (value: number | null): string => {
    if (value === null || !Number.isFinite(value)) {
      return 'n/a'
    }

    if (value >= 1000) {
      const megabits = value / 1000
      return `${megabits.toFixed(megabits >= 10 ? 0 : 1)}Mbps`
    }

    return `${value.toFixed(value >= 100 ? 0 : 1)}kbps`
  }

  const remoteVideoEntries = participants
    .flatMap((participant) => {
      const member = members.find((entry) => entry.user_id === participant.user_id)
      const dmParticipant = activeConversation?.participants.find(
        (entry) => entry.user_id === participant.user_id
      )
      const displayName =
        member?.user.display_name ||
        member?.user.username ||
        dmParticipant?.user.display_name ||
        dmParticipant?.user.username ||
        participant.user_id.slice(0, 8)
      const avatarUrl = member?.user.avatar_url ?? dmParticipant?.user.avatar_url ?? null
      const entries: OverlayEntry[] = []
      const shareStream = remoteMediaStreams[`${participant.user_id}:share_video`]
      const cameraStream = remoteMediaStreams[`${participant.user_id}:camera_video`]

      if (shareStream) {
        entries.push({
          id: `${participant.user_id}:share_video`,
          stream: shareStream,
          label: displayName,
          kind: 'share',
          avatarUrl,
          speaking: participant.speaking ?? false,
          participantMuted: participant.muted,
          isLocal: false,
          hasShareAudio: Boolean(participant.share_audio_track_id),
          testId: 'remote-screen-share'
        })
      }

      if (cameraStream) {
        entries.push({
          id: `${participant.user_id}:camera_video`,
          stream: cameraStream,
          label: displayName,
          kind: 'camera',
          avatarUrl,
          speaking: participant.speaking ?? false,
          participantMuted: participant.muted,
          isLocal: false,
          hasShareAudio: false,
          testId: `remote-video-${displayName}`
        })
      }

      return entries
    })
    .slice(0, 4)

  const localVideoEntries = ([
    localShareStream
      ? {
          id: 'local:share_video',
          stream: localShareStream,
          label: 'You',
          kind: 'share' as const,
          avatarUrl: null,
          speaking: false,
          participantMuted: muted,
          isLocal: true,
          hasShareAudio: shareAudioPreferred,
          testId: 'local-video'
        }
      : null,
    localCameraStream
      ? {
          id: 'local:camera_video',
          stream: localCameraStream,
          label: 'You',
          kind: 'camera' as const,
          avatarUrl: null,
          speaking: false,
          participantMuted: muted,
          isLocal: true,
          hasShareAudio: false,
          testId: 'local-video'
        }
      : null
  ] as (OverlayEntry | null)[]).filter((entry): entry is OverlayEntry => entry !== null)

  const overlayMediaEntries = [...remoteVideoEntries, ...localVideoEntries].slice(0, 4)

  const participantPills = participants.slice(0, 6).map((participant) => {
    const member = members.find((entry) => entry.user_id === participant.user_id)
    const dmParticipant = activeConversation?.participants.find(
      (entry) => entry.user_id === participant.user_id
    )
    const label =
      member?.user.display_name ||
      member?.user.username ||
      dmParticipant?.user.display_name ||
      dmParticipant?.user.username ||
      participant.user_id.slice(0, 8)
    const avatarUrl = member?.user.avatar_url ?? dmParticipant?.user.avatar_url ?? null
    const isLocal = participant.user_id === currentUserId
    const hasShare = isLocal
      ? Boolean(localShareStream || remoteMediaStreams[`${participant.user_id}:share_video`])
      : Boolean(remoteMediaStreams[`${participant.user_id}:share_video`])
    const hasCamera = isLocal
      ? Boolean(localCameraStream || remoteMediaStreams[`${participant.user_id}:camera_video`])
      : Boolean(remoteMediaStreams[`${participant.user_id}:camera_video`])

    return {
      id: participant.user_id,
      label,
      avatarUrl,
      speaking: participant.speaking ?? false,
      muted: participant.muted,
      hasShare,
      hasCamera
    }
  })

  const canShareVideo = voiceState === 'connected' || voiceState === 'in_call'
  const statusLabel =
    voiceState === 'ringing'
      ? 'Calling...'
      : voiceState === 'connecting'
        ? 'Connecting...'
        : 'Voice Connected'
  const qualityClass =
    connectionQuality === 'good'
      ? 'vesper-call-overlay-quality-good'
      : connectionQuality === 'fair'
        ? 'vesper-call-overlay-quality-fair'
        : connectionQuality === 'poor'
          ? 'vesper-call-overlay-quality-poor'
          : 'vesper-call-overlay-quality-unknown'

  return (
    <div
      data-testid="call-overlay"
      className={
        mobileDocked
          ? 'vesper-call-overlay vesper-call-overlay-discord vesper-call-overlay-docked'
          : 'vesper-call-overlay vesper-call-overlay-discord'
      }
    >
      <div className="vesper-call-overlay-shell glass-card">
        <div className="vesper-call-overlay-header">
          <div className="vesper-call-overlay-header-main">
            <span
              className={`vesper-call-overlay-status-dot ${qualityClass}`}
              aria-hidden="true"
            />
            <div className="vesper-call-overlay-header-copy">
              <p className="vesper-call-overlay-title">{statusLabel}</p>
              {voiceError ? (
                <p className="vesper-call-overlay-error">{voiceError}</p>
              ) : (
                <p className="vesper-call-overlay-subtitle">
                  {roomLabel}
                  {voiceState === 'in_call' || voiceState === 'connected'
                    ? ` · ${formatDuration(duration)}`
                    : ''}
                </p>
              )}
            </div>
          </div>
          <div className="vesper-call-overlay-connection">
            <span className={`vesper-call-overlay-quality ${qualityClass}`}>
              {connectionQuality.toUpperCase()}
            </span>
            <span className="vesper-call-overlay-count">
              {participants.length} in call
            </span>
          </div>
        </div>

        {(roundTripMs !== null ||
          packetLossPct !== null ||
          inboundBitrateKbps !== null ||
          outboundBitrateKbps !== null) && (
          <div className="vesper-call-overlay-metrics">
            <span className="vesper-call-overlay-metric">
              RTT {roundTripMs !== null ? `${roundTripMs}ms` : 'n/a'}
            </span>
            <span className="vesper-call-overlay-metric">
              Loss {packetLossPct !== null ? `${packetLossPct}%` : 'n/a'}
            </span>
            <span className="vesper-call-overlay-metric">
              In {formatBitrate(inboundBitrateKbps)}
            </span>
            <span className="vesper-call-overlay-metric">
              Out {formatBitrate(outboundBitrateKbps)}
            </span>
          </div>
        )}

        {overlayMediaEntries.length > 0 && (
          <div
            className={`vesper-call-overlay-grid ${getOverlayGridClass(overlayMediaEntries.length)}`}
          >
            {overlayMediaEntries.map((entry) => (
              <OverlayVideoTile
                key={entry.id}
                stream={entry.stream}
                label={entry.label}
                kind={entry.kind}
                avatarUrl={entry.avatarUrl}
                muted={entry.isLocal}
                mirror={entry.isLocal && entry.kind === 'camera'}
                speaking={entry.speaking}
                participantMuted={entry.participantMuted}
                isLocal={entry.isLocal}
                hasShareAudio={entry.hasShareAudio}
                testId={entry.testId}
              />
            ))}
          </div>
        )}

        {participantPills.length > 0 && (
          <div className="vesper-call-overlay-presence-strip">
            {participantPills.map((participant) => (
              <CallPresencePill key={participant.id} participant={participant} />
            ))}
          </div>
        )}

        <div className="vesper-call-overlay-footer">
          <div className="vesper-call-overlay-controls">
            <button
              data-testid="mute-button"
              onClick={toggleMute}
              className={`vesper-call-overlay-control${
                muted ? ' vesper-call-overlay-control-danger' : ''
              }`}
              title={muted ? 'Unmute' : 'Mute'}
              type="button"
            >
              {muted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>

            <button
              onClick={toggleDeafen}
              className={`vesper-call-overlay-control${
                deafened ? ' vesper-call-overlay-control-danger' : ''
              }`}
              title={deafened ? 'Undeafen' : 'Deafen'}
              type="button"
            >
              {deafened ? (
                <HeadphoneOff className="w-4 h-4" />
              ) : (
                <Headphones className="w-4 h-4" />
              )}
            </button>

            <button
              data-testid="disconnect-call"
              onClick={disconnect}
              className="vesper-call-overlay-control vesper-call-overlay-control-hangup"
              title="Hang up"
              type="button"
            >
              <PhoneOff className="w-4 h-4" />
            </button>

            <button
              data-testid="camera-button"
              onClick={() => {
                void toggleCamera()
              }}
              disabled={!canShareVideo}
              className={`vesper-call-overlay-control${
                cameraEnabled ? ' vesper-call-overlay-control-active' : ''
              }${!canShareVideo ? ' vesper-call-overlay-control-disabled' : ''}`}
              title={cameraEnabled ? 'Stop Camera' : 'Start Camera'}
              type="button"
            >
              {cameraEnabled ? (
                <VideoOff className="w-4 h-4" />
              ) : (
                <Video className="w-4 h-4" />
              )}
            </button>

            <button
              data-testid="screen-share-button"
              onClick={() => {
                void toggleScreenShare(undefined, shareAudioPreferred)
              }}
              disabled={!canShareVideo}
              className={`vesper-call-overlay-control${
                screenShareEnabled ? ' vesper-call-overlay-control-active' : ''
              }${!canShareVideo ? ' vesper-call-overlay-control-disabled' : ''}`}
              title={screenShareEnabled ? 'Stop Screen Share' : 'Start Screen Share'}
              type="button"
            >
              {screenShareEnabled ? (
                <ScreenShareOff className="w-4 h-4" />
              ) : (
                <ScreenShare className="w-4 h-4" />
              )}
            </button>
          </div>

          {canShareVideo && (
            <label className="vesper-call-overlay-share-audio">
              <input
                type="checkbox"
                checked={shareAudioPreferred}
                onChange={(event) => setShareAudioPreferred(event.target.checked)}
              />
              <span>Share system audio</span>
            </label>
          )}
        </div>
      </div>
    </div>
  )
}

function CallPresencePill({
  participant
}: {
  participant: {
    id: string
    label: string
    avatarUrl: string | null
    speaking: boolean
    muted: boolean
    hasShare: boolean
    hasCamera: boolean
  }
}): React.JSX.Element {
  const initials = getInitials(participant.label)

  return (
    <div
      className={
        participant.speaking
          ? 'vesper-call-overlay-presence-pill vesper-call-overlay-presence-pill-speaking'
          : 'vesper-call-overlay-presence-pill'
      }
    >
      <div className="vesper-call-overlay-presence-avatar">
        {participant.avatarUrl ? (
          <img
            src={participant.avatarUrl}
            alt=""
            className="vesper-call-overlay-presence-avatar-image"
          />
        ) : (
          <span className="vesper-call-overlay-presence-avatar-fallback">{initials}</span>
        )}
        {participant.muted && (
          <span className="vesper-call-overlay-presence-muted">
            <MicOff className="w-2.5 h-2.5" />
          </span>
        )}
      </div>
      <div className="vesper-call-overlay-presence-copy">
        <span className="vesper-call-overlay-presence-name">{participant.label}</span>
        <span className="vesper-call-overlay-presence-meta">
          {participant.hasShare
            ? 'Screen'
            : participant.hasCamera
              ? 'Camera'
              : participant.speaking
                ? 'Speaking'
                : 'Audio'}
        </span>
      </div>
    </div>
  )
}
