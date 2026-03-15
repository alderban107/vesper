import { useState } from 'react'
import { MicOff, ScreenShare, Video, Volume2, VolumeX } from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import { useVoiceStore, VoiceParticipant } from '../../stores/voiceStore'
import { useServerStore } from '../../stores/serverStore'
import Avatar from '../ui/Avatar'

export default function VoiceParticipants({
  channelId
}: {
  channelId: string
}): React.JSX.Element | null {
  const voiceState = useVoiceStore((s) => s.state)
  const roomId = useVoiceStore((s) => s.roomId)
  const participants = useVoiceStore((s) => s.participants)
  const members = useServerStore((s) => s.members)
  const remoteVolumes = useVoiceStore((s) => s.remoteVolumes)
  const setRemoteVolume = useVoiceStore((s) => s.setRemoteVolume)
  const currentUserId = useAuthStore((s) => s.user?.id ?? null)

  if (voiceState === 'idle' || roomId !== channelId) return null

  return (
    <div className="pl-8 pr-3">
      {participants.map((p) => (
        <ParticipantRow
          key={p.user_id}
          participant={p}
          member={members.find((member) => member.user_id === p.user_id)}
          isSelf={p.user_id === currentUserId}
          volume={remoteVolumes[p.user_id] ?? 100}
          onVolumeChange={(volume) => setRemoteVolume(p.user_id, volume)}
        />
      ))}
    </div>
  )
}

function ParticipantRow({
  participant,
  member,
  isSelf,
  volume,
  onVolumeChange
}: {
  participant: VoiceParticipant
  member:
    | {
        user: {
          id: string
          username: string
          display_name: string | null
          avatar_url: string | null
        }
      }
    | undefined
  isSelf: boolean
  volume: number
  onVolumeChange: (volume: number) => void
}): React.JSX.Element {
  const displayName = member?.user.display_name || member?.user.username || participant.user_id.slice(0, 8)
  const [expanded, setExpanded] = useState(false)
  const isMutedLocally = volume === 0

  return (
    <div className="vesper-voice-participant">
      <div className="vesper-voice-participant-row">
        <div className="vesper-voice-participant-row-content">
          <div className={`vesper-voice-participant-avatar${participant.speaking ? ' vesper-voice-participant-avatar-speaking' : ''}`}>
            <span className="vesper-voice-participant-avatar-ring" aria-hidden="true" />
            <Avatar
              userId={participant.user_id}
              avatarUrl={member?.user.avatar_url}
              displayName={displayName}
              size="xs"
            />
          </div>
          <span data-testid="voice-participant-name" className={participant.speaking ? 'vesper-voice-participant-name vesper-voice-participant-name-speaking' : 'vesper-voice-participant-name'}>
            {displayName}
          </span>
          <div className="vesper-voice-participant-icons">
            {participant.camera_video_track_id && <Video className="vesper-voice-participant-state-icon" />}
            {participant.share_video_track_id && <ScreenShare className="vesper-voice-participant-state-icon" />}
            {participant.muted && <MicOff className="vesper-voice-participant-state-icon vesper-voice-participant-state-icon-muted" />}
          </div>
        </div>
        {!isSelf && (
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            className="vesper-voice-participant-volume-button"
            title="Adjust volume"
          >
            {isMutedLocally ? (
              <VolumeX className="w-3.5 h-3.5" />
            ) : (
              <Volume2 className="w-3.5 h-3.5" />
            )}
          </button>
        )}
      </div>

      {!isSelf && expanded && (
        <div className="vesper-voice-participant-volume-panel">
          <input
            type="range"
            min={0}
            max={200}
            step={1}
            value={volume}
            onChange={(event) => onVolumeChange(Number(event.target.value))}
            className="vesper-voice-participant-slider"
          />
          <span className="vesper-voice-participant-volume-copy">{volume}%</span>
        </div>
      )}
    </div>
  )
}
