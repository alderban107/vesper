import { useState } from 'react'
import { MicOff, Volume2, VolumeX } from 'lucide-react'
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

  if (voiceState === 'idle' || roomId !== channelId) return null

  return (
    <div className="pl-8 pr-3">
      {participants.map((p) => (
        <ParticipantRow
          key={p.user_id}
          participant={p}
          member={members.find((member) => member.user_id === p.user_id)}
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
  volume: number
  onVolumeChange: (volume: number) => void
}): React.JSX.Element {
  const displayName = member?.user.display_name || member?.user.username || participant.user_id.slice(0, 8)
  const [expanded, setExpanded] = useState(false)
  const isMutedLocally = volume === 0

  return (
    <div className="vesper-voice-participant">
      <div className="vesper-voice-participant-row">
        <Avatar
          userId={participant.user_id}
          avatarUrl={member?.user.avatar_url}
          displayName={displayName}
          size="xs"
        />
        <span
          className={`w-2 h-2 rounded-full border transition-all ${
            participant.speaking
              ? 'bg-success border-success shadow-[0_0_6px_rgba(52,211,153,0.5)] animate-pulse'
              : 'bg-text-faintest border-transparent'
          }`}
        />
        <span
          className={`text-xs truncate transition-colors ${
            participant.speaking ? 'text-text-primary' : 'text-text-muted'
          }`}
        >
          {displayName}
        </span>
        {participant.muted && (
          <MicOff className="w-3 h-3 text-red-400" />
        )}
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
      </div>

      {expanded && (
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
