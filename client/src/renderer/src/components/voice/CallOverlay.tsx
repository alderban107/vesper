import { useEffect, useRef, useState } from 'react'
import { Mic, MicOff, Headphones, HeadphoneOff, PhoneOff, Video, VideoOff, ScreenShare, ScreenShareOff } from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import { useVoiceStore } from '../../stores/voiceStore'
import { useServerStore } from '../../stores/serverStore'
import { useDmStore } from '../../stores/dmStore'

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

function OverlayVideo({
  stream,
  muted = false,
  className,
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
  className?: string
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

  const initials = label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?'

  return (
    <div data-testid={testId} className={speaking ? 'vesper-call-overlay-video-shell vesper-call-overlay-video-shell-speaking' : 'vesper-call-overlay-video-shell'}>
      {!ready && (
        <div className="vesper-call-overlay-video-loading">
          {avatarUrl ? <img src={avatarUrl} alt="" className="vesper-call-overlay-video-preview" /> : null}
          <div className="vesper-call-overlay-video-fallback">{initials}</div>
        </div>
      )}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        onLoadedData={() => setReady(true)}
        className={`${className ?? ''}${mirror ? ' vesper-call-overlay-video-mirror' : ''}`}
      />
      <div className="vesper-call-overlay-video-topline">
        <div className="vesper-call-overlay-video-chips">
          <span className="vesper-call-overlay-video-kind">{kind === 'share' ? 'Share' : 'Camera'}</span>
          {isLocal && <span className="vesper-call-overlay-video-chip">You</span>}
          {participantMuted && <span className="vesper-call-overlay-video-chip">Muted</span>}
          {hasShareAudio && kind === 'share' && <span className="vesper-call-overlay-video-chip">Audio</span>}
        </div>
      </div>
      <div className="vesper-call-overlay-video-meta">
        <span className="vesper-call-overlay-video-label">{label}</span>
        <span className="vesper-call-overlay-video-state">
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

export default function CallOverlay(): React.JSX.Element | null {
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
      setDuration((d) => d + 1)
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
  const activeConversation = roomType === 'dm'
    ? conversations.find((conversation) => conversation.id === roomId) ?? null
    : null

  const formatDuration = (seconds: number): string => {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${s.toString().padStart(2, '0')}`
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
      const dmParticipant = activeConversation?.participants.find((entry) => entry.user_id === participant.user_id)
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
    .slice(0, 3)

  const localVideoEntries = [
    localShareStream ? {
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
    } : null,
    localCameraStream ? {
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
    } : null
  ].filter((entry): entry is OverlayEntry => entry !== null)

  const overlayMediaEntries = [...remoteVideoEntries, ...localVideoEntries]

  const participantPills = participants
    .slice(0, 6)
    .map((participant) => {
      const member = members.find((entry) => entry.user_id === participant.user_id)
      const dmParticipant = activeConversation?.participants.find((entry) => entry.user_id === participant.user_id)
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
        : 'Voice Active'
  const qualityClass =
    connectionQuality === 'good'
      ? 'vesper-call-overlay-quality-good'
      : connectionQuality === 'fair'
        ? 'vesper-call-overlay-quality-fair'
        : connectionQuality === 'poor'
          ? 'vesper-call-overlay-quality-poor'
          : 'vesper-call-overlay-quality-unknown'

  return (
    <div data-testid="call-overlay" className="vesper-call-overlay">
      <div className="vesper-call-overlay-shell glass-card">
        <div className="vesper-call-overlay-status-row">
          <div className="vesper-call-overlay-status-copy">
            <span className={`vesper-call-overlay-status-dot ${qualityClass}`} aria-hidden="true" />
            <div className="vesper-call-overlay-header-copy">
              <p className="vesper-call-overlay-title">{statusLabel}</p>
              {voiceError ? (
                <p className="vesper-call-overlay-error">{voiceError}</p>
              ) : voiceState === 'in_call' || voiceState === 'connected' ? (
                <p className="vesper-call-overlay-subtitle">{roomLabel} · {formatDuration(duration)}</p>
              ) : (
                <p className="vesper-call-overlay-subtitle">{roomLabel}</p>
              )}
            </div>
          </div>
          <div className="vesper-call-overlay-connection">
            <span className={`vesper-call-overlay-quality ${qualityClass}`}>
              {connectionQuality.toUpperCase()}
            </span>
            <span className="vesper-call-overlay-count">
              {participants.length} participant{participants.length !== 1 ? 's' : ''}
            </span>
          </div>
        </div>

        {(roundTripMs !== null || packetLossPct !== null || inboundBitrateKbps !== null || outboundBitrateKbps !== null) && (
          <div className="vesper-call-overlay-metrics-row">
            {(roundTripMs !== null || packetLossPct !== null) && (
              <div className="vesper-call-overlay-stats">
                <span>RTT {roundTripMs !== null ? `${roundTripMs}ms` : 'n/a'}</span>
                <span>Loss {packetLossPct !== null ? `${packetLossPct}%` : 'n/a'}</span>
              </div>
            )}
            {(inboundBitrateKbps !== null || outboundBitrateKbps !== null) && (
              <div className="vesper-call-overlay-stats">
                <span>In {formatBitrate(inboundBitrateKbps)}</span>
                <span>Out {formatBitrate(outboundBitrateKbps)}</span>
              </div>
            )}
          </div>
        )}

        {overlayMediaEntries.length > 0 && (
          <div className="vesper-call-overlay-media-rail">
            {overlayMediaEntries.map((entry) => (
              <OverlayVideo
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
                className={`vesper-call-overlay-video${entry.isLocal ? ' vesper-call-overlay-video-local' : ''}`}
              />
            ))}
          </div>
        )}

        {participantPills.length > 0 && (
          <div className="vesper-call-overlay-presence-row">
            {participantPills.map((participant) => (
              <CallPresencePill key={participant.id} participant={participant} />
            ))}
          </div>
        )}

        <div className="vesper-call-overlay-controls">
          <button
            data-testid="mute-button"
            onClick={toggleMute}
            className={`vesper-call-overlay-control${
              muted
                ? ' vesper-call-overlay-control-danger'
                : ''
            }`}
            title={muted ? 'Unmute' : 'Mute'}
          >
            {muted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
          </button>

          <button
            onClick={toggleDeafen}
            className={`vesper-call-overlay-control${
              deafened
                ? ' vesper-call-overlay-control-danger'
                : ''
            }`}
            title={deafened ? 'Undeafen' : 'Deafen'}
          >
            {deafened ? <HeadphoneOff className="w-4 h-4" /> : <Headphones className="w-4 h-4" />}
          </button>

          <button
            data-testid="disconnect-call"
            onClick={disconnect}
            className="vesper-call-overlay-control vesper-call-overlay-control-hangup"
            title="Hang up"
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
              cameraEnabled
                ? ' vesper-call-overlay-control-active'
                : ''
            }${!canShareVideo ? ' vesper-call-overlay-control-disabled' : ''}`}
            title={cameraEnabled ? 'Stop Camera' : 'Start Camera'}
          >
            {cameraEnabled ? <VideoOff className="w-4 h-4" /> : <Video className="w-4 h-4" />}
          </button>

          <button
            data-testid="screen-share-button"
            onClick={() => {
              void toggleScreenShare(undefined, shareAudioPreferred)
            }}
            disabled={!canShareVideo}
            className={`vesper-call-overlay-control${
              screenShareEnabled
                ? ' vesper-call-overlay-control-active'
                : ''
            }${!canShareVideo ? ' vesper-call-overlay-control-disabled' : ''}`}
            title={screenShareEnabled ? 'Stop Screen Share' : 'Start Screen Share'}
          >
            {screenShareEnabled
              ? <ScreenShareOff className="w-4 h-4" />
              : <ScreenShare className="w-4 h-4" />}
          </button>
        </div>

        {canShareVideo && (
          <label className="vesper-call-overlay-share-audio">
            <input
              type="checkbox"
              checked={shareAudioPreferred}
              onChange={(event) => setShareAudioPreferred(event.target.checked)}
            />
            <span>Share system audio when available</span>
          </label>
        )}
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
  const initials = participant.label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?'

  return (
    <div className={participant.speaking ? 'vesper-call-overlay-presence-pill vesper-call-overlay-presence-pill-speaking' : 'vesper-call-overlay-presence-pill'}>
      <div className="vesper-call-overlay-presence-avatar">
        {participant.avatarUrl ? (
          <img src={participant.avatarUrl} alt="" className="vesper-call-overlay-presence-avatar-image" />
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
            ? 'Live'
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
