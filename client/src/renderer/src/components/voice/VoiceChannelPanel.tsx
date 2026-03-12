import { useEffect, useRef, useState } from 'react'
import { Headphones, HeadphoneOff, Mic, MicOff, PhoneOff, Volume2, Video, VideoOff, ScreenShare, ScreenShareOff } from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import { useServerStore } from '../../stores/serverStore'
import { useVoiceStore } from '../../stores/voiceStore'
import Avatar from '../ui/Avatar'

function VoiceVideoSurface({
  stream,
  muted = false,
  className
}: {
  stream: MediaStream
  muted?: boolean
  className?: string
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    if (!videoRef.current) {
      return
    }

    if (videoRef.current.srcObject !== stream) {
      videoRef.current.srcObject = stream
    }

    return () => {
      if (videoRef.current) {
        videoRef.current.srcObject = null
      }
    }
  }, [stream])

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted={muted}
      className={className ?? ''}
    />
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
  const videoMode = useVoiceStore((s) => s.videoMode)
  const localVideoStream = useVoiceStore((s) => s.localVideoStream)
  const remoteVideoStreams = useVoiceStore((s) => s.remoteVideoStreams)
  const setRemoteVolume = useVoiceStore((s) => s.setRemoteVolume)
  const toggleMute = useVoiceStore((s) => s.toggleMute)
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen)
  const toggleCamera = useVoiceStore((s) => s.toggleCamera)
  const toggleScreenShare = useVoiceStore((s) => s.toggleScreenShare)
  const joinVoiceChannel = useVoiceStore((s) => s.joinVoiceChannel)
  const disconnect = useVoiceStore((s) => s.disconnect)
  const myUserId = useAuthStore((s) => s.user?.id ?? null)
  const [pinnedParticipantId, setPinnedParticipantId] = useState<string | null>(null)

  if (!activeChannel || activeChannel.type !== 'voice') {
    return null
  }

  const isConnected = roomType === 'channel' && roomId === activeChannel.id && voiceState !== 'idle'
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
  const participantCards = participants.map((participant) => {
    const member = members.find((entry) => entry.user_id === participant.user_id)
    const displayName = member?.user.display_name || member?.user.username || participant.user_id.slice(0, 8)

    return {
      id: participant.user_id,
      displayName,
      avatarUrl: member?.user.avatar_url,
      speaking: participant.speaking ?? false,
      muted: participant.muted,
      isLocal: participant.user_id === myUserId,
      videoStream:
        participant.user_id === myUserId
          ? localVideoStream
          : remoteVideoStreams[participant.user_id] ?? null
    }
  })
  const pinnedParticipant = pinnedParticipantId
    ? participantCards.find((participant) => participant.id === pinnedParticipantId) ?? null
    : null

  useEffect(() => {
    if (!pinnedParticipantId) {
      return
    }

    if (!participantCards.some((participant) => participant.id === pinnedParticipantId)) {
      setPinnedParticipantId(null)
    }
  }, [participantCards, pinnedParticipantId])

  return (
    <div className="vesper-voice-room">
      <div className="vesper-voice-room-hero">
        <div className="vesper-voice-room-hero-copy">
          <div className="vesper-voice-room-kicker">{activeServer?.name || 'Server Voice'}</div>
          <h2 className="vesper-voice-room-title">{activeChannel.name}</h2>
          <p className="vesper-voice-room-description">
            {isConnected
              ? 'You are live in this channel. Your audio stays end-to-end encrypted from capture to transport.'
              : 'Join this voice room to talk with everyone already hanging out here.'}
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
                  void toggleCamera()
                }}
                className={`vesper-voice-room-button${cameraEnabled ? ' vesper-voice-room-button-active' : ''}`}
              >
                {cameraEnabled ? <VideoOff className="w-4 h-4" /> : <Video className="w-4 h-4" />}
                {cameraEnabled ? 'Stop Camera' : 'Camera'}
              </button>
              <button
                type="button"
                onClick={() => {
                  void toggleScreenShare()
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
              className="vesper-voice-room-button vesper-voice-room-button-primary"
            >
              <Volume2 className="w-4 h-4" />
              Join Voice
            </button>
          )}
        </div>
      </div>

      {pinnedParticipant && (
        <div className="vesper-voice-room-featured">
          <div className="vesper-voice-room-featured-header">
            <div>
              <div className="vesper-voice-room-featured-kicker">Focused Participant</div>
              <div className="vesper-voice-room-featured-name">{pinnedParticipant.displayName}</div>
              <div className="vesper-voice-room-featured-meta">
                {pinnedParticipant.muted
                  ? 'Muted'
                  : pinnedParticipant.speaking
                    ? 'Speaking now'
                    : 'Listening'}
              </div>
            </div>
            <button
              type="button"
              className="vesper-voice-room-featured-clear"
              onClick={() => setPinnedParticipantId(null)}
            >
              Clear Focus
            </button>
          </div>
          {pinnedParticipant.videoStream ? (
            <VoiceVideoSurface
              stream={pinnedParticipant.videoStream}
              muted={pinnedParticipant.isLocal}
              className="vesper-voice-room-featured-video"
            />
          ) : (
            <Avatar
              userId={pinnedParticipant.id}
              avatarUrl={pinnedParticipant.avatarUrl}
              displayName={pinnedParticipant.displayName}
              size="lg"
              speaking={pinnedParticipant.speaking}
            />
          )}
        </div>
      )}

      <div className="vesper-voice-room-grid">
        {participantCards.length > 0 ? (
          participantCards.map((participant) => (
            <div
              key={participant.id}
              className={`vesper-voice-room-card${participant.id === pinnedParticipantId ? ' vesper-voice-room-card-pinned' : ''}`}
            >
              <button
                type="button"
                className={`vesper-voice-room-card-pin${participant.id === pinnedParticipantId ? ' vesper-voice-room-card-pin-active' : ''}`}
                onClick={() =>
                  setPinnedParticipantId((current) =>
                    current === participant.id ? null : participant.id
                  )
                }
              >
                {participant.id === pinnedParticipantId ? 'Focused' : 'Focus'}
              </button>
              <div className="vesper-voice-room-card-media">
                {participant.videoStream ? (
                  <VoiceVideoSurface
                    stream={participant.videoStream}
                    muted={participant.isLocal}
                    className="vesper-voice-room-card-video"
                  />
                ) : (
                  <Avatar
                    userId={participant.id}
                    avatarUrl={participant.avatarUrl}
                    displayName={participant.displayName}
                    size="lg"
                    speaking={participant.speaking}
                  />
                )}
              </div>
              <div className="vesper-voice-room-card-name">{participant.displayName}</div>
              <div className="vesper-voice-room-card-meta">
                {participant.videoStream
                  ? participant.isLocal
                    ? videoMode === 'screen'
                      ? 'Sharing screen'
                      : 'Camera on'
                    : 'Video live'
                  : participant.muted
                    ? 'Muted'
                    : participant.speaking
                      ? 'Speaking'
                      : 'Listening'}
              </div>
              {isConnected && participant.id !== myUserId && (
                <label className="vesper-voice-room-volume">
                  <span>Volume</span>
                  <input
                    type="range"
                    min={0}
                    max={200}
                    step={1}
                    value={remoteVolumes[participant.id] ?? 100}
                    onChange={(event) => setRemoteVolume(participant.id, Number(event.target.value))}
                  />
                </label>
              )}
            </div>
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
