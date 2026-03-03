import { MicOff } from 'lucide-react'
import { useVoiceStore, VoiceParticipant } from '../../stores/voiceStore'

export default function VoiceParticipants({
  channelId
}: {
  channelId: string
}): React.JSX.Element | null {
  const voiceState = useVoiceStore((s) => s.state)
  const roomId = useVoiceStore((s) => s.roomId)
  const participants = useVoiceStore((s) => s.participants)

  if (voiceState === 'idle' || roomId !== channelId) return null

  return (
    <div className="pl-8 pr-3">
      {participants.map((p) => (
        <ParticipantRow key={p.user_id} participant={p} />
      ))}
    </div>
  )
}

function ParticipantRow({ participant }: { participant: VoiceParticipant }): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5 py-0.5">
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
        {participant.user_id.slice(0, 8)}
      </span>
      {participant.muted && (
        <MicOff className="w-3 h-3 text-red-400" />
      )}
    </div>
  )
}
