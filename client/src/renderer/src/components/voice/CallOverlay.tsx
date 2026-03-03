import { useEffect, useState } from 'react'
import { Mic, MicOff, Headphones, HeadphoneOff, PhoneOff } from 'lucide-react'
import { useVoiceStore } from '../../stores/voiceStore'

export default function CallOverlay(): React.JSX.Element | null {
  const voiceState = useVoiceStore((s) => s.state)
  const roomType = useVoiceStore((s) => s.roomType)
  const participants = useVoiceStore((s) => s.participants)
  const muted = useVoiceStore((s) => s.muted)
  const deafened = useVoiceStore((s) => s.deafened)
  const disconnect = useVoiceStore((s) => s.disconnect)
  const toggleMute = useVoiceStore((s) => s.toggleMute)
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen)

  const [duration, setDuration] = useState(0)

  useEffect(() => {
    if (voiceState !== 'in_call') {
      setDuration(0)
      return
    }

    const interval = setInterval(() => {
      setDuration((d) => d + 1)
    }, 1000)

    return () => clearInterval(interval)
  }, [voiceState])

  if (roomType !== 'dm' || (voiceState !== 'in_call' && voiceState !== 'ringing')) {
    return null
  }

  const formatDuration = (seconds: number): string => {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  return (
    <div className="fixed bottom-4 right-4 glass-card rounded-2xl p-4 w-64 z-40 animate-slide-up">
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-text-primary text-sm font-semibold">
            {voiceState === 'ringing' ? 'Calling...' : 'In Call'}
          </p>
          {voiceState === 'in_call' && (
            <p className="text-text-faint text-xs">{formatDuration(duration)}</p>
          )}
        </div>
        <span className="text-success text-xs font-medium">
          {participants.length} participant{participants.length !== 1 ? 's' : ''}
        </span>
      </div>

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
    </div>
  )
}
