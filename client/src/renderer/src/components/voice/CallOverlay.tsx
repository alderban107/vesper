import { useEffect, useRef, useState } from 'react'
import { Mic, MicOff, Headphones, HeadphoneOff, PhoneOff, Video, VideoOff, ScreenShare, ScreenShareOff } from 'lucide-react'
import { useVoiceStore } from '../../stores/voiceStore'
import { useServerStore } from '../../stores/serverStore'
import { useDmStore } from '../../stores/dmStore'

function OverlayVideo({
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
  const localVideoStream = useVoiceStore((s) => s.localVideoStream)
  const remoteVideoStreams = useVoiceStore((s) => s.remoteVideoStreams)
  const toggleCamera = useVoiceStore((s) => s.toggleCamera)
  const toggleScreenShare = useVoiceStore((s) => s.toggleScreenShare)
  const activeServer = useServerStore((s) => s.servers.find((server) => server.id === s.activeServerId))
  const conversations = useDmStore((s) => s.conversations)

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
    .map((participant) => ({
      id: participant.user_id,
      stream: remoteVideoStreams[participant.user_id] ?? null
    }))
    .filter((entry) => entry.stream !== null)
    .slice(0, 2) as Array<{ id: string, stream: MediaStream }>

  const canShareVideo = voiceState === 'connected' || voiceState === 'in_call'

  return (
    <div className="vesper-call-overlay fixed bottom-4 right-4 glass-card rounded-2xl p-4 w-72 z-40 animate-slide-up">
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-text-primary text-sm font-semibold">
            {voiceState === 'ringing' ? 'Calling...' : voiceState === 'connecting' ? 'Connecting...' : 'Voice Active'}
          </p>
          {voiceError ? (
            <p className="text-red-300 text-xs max-w-[12rem] leading-relaxed">{voiceError}</p>
          ) : voiceState === 'in_call' || voiceState === 'connected' ? (
            <p className="text-text-faint text-xs">{roomLabel} · {formatDuration(duration)}</p>
          ) : (
            <p className="text-text-faint text-xs">{roomLabel}</p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`text-xs font-semibold ${
            connectionQuality === 'good'
              ? 'text-emerald-300'
              : connectionQuality === 'fair'
                ? 'text-amber-300'
                : connectionQuality === 'poor'
                  ? 'text-red-300'
                  : 'text-text-faint'
          }`}>
            {connectionQuality.toUpperCase()}
          </span>
          <span className="text-text-faint text-[10px]">
            {participants.length} participant{participants.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {(roundTripMs !== null || packetLossPct !== null) && (
        <div className="mb-3 flex items-center gap-2 text-[11px] text-text-faint">
          <span>RTT {roundTripMs !== null ? `${roundTripMs}ms` : 'n/a'}</span>
          <span>•</span>
          <span>Loss {packetLossPct !== null ? `${packetLossPct}%` : 'n/a'}</span>
        </div>
      )}

      {(inboundBitrateKbps !== null || outboundBitrateKbps !== null) && (
        <div className="mb-3 flex items-center gap-2 text-[11px] text-text-faint">
          <span>In {formatBitrate(inboundBitrateKbps)}</span>
          <span>•</span>
          <span>Out {formatBitrate(outboundBitrateKbps)}</span>
        </div>
      )}

      {(remoteVideoEntries.length > 0 || localVideoStream) && (
        <div className="vesper-call-overlay-video-grid">
          {remoteVideoEntries.map((entry) => (
            <OverlayVideo
              key={entry.id}
              stream={entry.stream}
              className="vesper-call-overlay-video"
            />
          ))}
          {localVideoStream && (
            <OverlayVideo
              stream={localVideoStream}
              muted
              className="vesper-call-overlay-video vesper-call-overlay-video-local"
            />
          )}
        </div>
      )}

      <div className="flex gap-2 justify-center">
        <button
          onClick={toggleMute}
          className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${
            muted
              ? 'bg-red-600/20 text-red-400'
              : 'bg-bg-tertiary/50 text-text-primary hover:bg-bg-tertiary'
          }`}
          title={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
        </button>

        <button
          onClick={toggleDeafen}
          className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${
            deafened
              ? 'bg-red-600/20 text-red-400'
              : 'bg-bg-tertiary/50 text-text-primary hover:bg-bg-tertiary'
          }`}
          title={deafened ? 'Undeafen' : 'Deafen'}
        >
          {deafened ? <HeadphoneOff className="w-4 h-4" /> : <Headphones className="w-4 h-4" />}
        </button>

        <button
          onClick={disconnect}
          className="w-10 h-10 rounded-full bg-red-600/20 hover:bg-red-600/30 text-red-400 flex items-center justify-center transition-colors"
          title="Hang up"
        >
          <PhoneOff className="w-4 h-4" />
        </button>
      </div>

      <div className="mt-2 flex gap-2 justify-center">
        <button
          onClick={() => {
            void toggleCamera()
          }}
          disabled={!canShareVideo}
          className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${
            cameraEnabled
              ? 'bg-emerald-600/20 text-emerald-300'
              : 'bg-bg-tertiary/50 text-text-primary hover:bg-bg-tertiary'
          } ${!canShareVideo ? 'opacity-45 cursor-not-allowed' : ''}`}
          title={cameraEnabled ? 'Stop Camera' : 'Start Camera'}
        >
          {cameraEnabled ? <VideoOff className="w-4 h-4" /> : <Video className="w-4 h-4" />}
        </button>

        <button
          onClick={() => {
            void toggleScreenShare()
          }}
          disabled={!canShareVideo}
          className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${
            screenShareEnabled
              ? 'bg-emerald-600/20 text-emerald-300'
              : 'bg-bg-tertiary/50 text-text-primary hover:bg-bg-tertiary'
          } ${!canShareVideo ? 'opacity-45 cursor-not-allowed' : ''}`}
          title={screenShareEnabled ? 'Stop Screen Share' : 'Start Screen Share'}
        >
          {screenShareEnabled
            ? <ScreenShareOff className="w-4 h-4" />
            : <ScreenShare className="w-4 h-4" />}
        </button>
      </div>
    </div>
  )
}
