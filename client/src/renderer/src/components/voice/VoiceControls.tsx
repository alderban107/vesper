import { Mic, MicOff, Headphones, HeadphoneOff, PhoneOff, Video, VideoOff, ScreenShare, ScreenShareOff } from 'lucide-react'
import { useVoiceStore } from '../../stores/voiceStore'

export default function VoiceControls(): React.JSX.Element | null {
  const voiceState = useVoiceStore((s) => s.state)
  const muted = useVoiceStore((s) => s.muted)
  const deafened = useVoiceStore((s) => s.deafened)
  const disconnect = useVoiceStore((s) => s.disconnect)
  const toggleMute = useVoiceStore((s) => s.toggleMute)
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen)
  const cameraEnabled = useVoiceStore((s) => s.cameraEnabled)
  const screenShareEnabled = useVoiceStore((s) => s.screenShareEnabled)
  const toggleCamera = useVoiceStore((s) => s.toggleCamera)
  const toggleScreenShare = useVoiceStore((s) => s.toggleScreenShare)
  const canShareVideo = voiceState === 'connected' || voiceState === 'in_call'

  if (voiceState === 'idle') return null

  return (
    <div className="px-3 py-2 bg-bg-base/50 border-t border-border">
      <div className="flex items-center gap-2 mb-2">
        <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
        <span className="text-success text-xs font-semibold">
          {voiceState === 'connecting' ? 'Connecting...' : 'Voice Connected'}
        </span>
      </div>

      <div className="flex gap-1.5">
        <button
          onClick={toggleMute}
          className={`flex-1 py-1.5 rounded-lg flex items-center justify-center gap-1.5 text-xs font-medium transition-all ${
            muted
              ? 'bg-red-600/20 text-red-400'
              : 'bg-bg-tertiary/50 text-text-muted hover:text-text-primary hover:bg-bg-tertiary'
          }`}
          title={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
        </button>

        <button
          onClick={toggleDeafen}
          className={`flex-1 py-1.5 rounded-lg flex items-center justify-center gap-1.5 text-xs font-medium transition-all ${
            deafened
              ? 'bg-red-600/20 text-red-400'
              : 'bg-bg-tertiary/50 text-text-muted hover:text-text-primary hover:bg-bg-tertiary'
          }`}
          title={deafened ? 'Undeafen' : 'Deafen'}
        >
          {deafened ? <HeadphoneOff className="w-3.5 h-3.5" /> : <Headphones className="w-3.5 h-3.5" />}
        </button>

        <button
          onClick={() => {
            void toggleCamera()
          }}
          disabled={!canShareVideo}
          className={`flex-1 py-1.5 rounded-lg flex items-center justify-center gap-1.5 text-xs font-medium transition-all ${
            cameraEnabled
              ? 'bg-emerald-600/20 text-emerald-300'
              : 'bg-bg-tertiary/50 text-text-muted hover:text-text-primary hover:bg-bg-tertiary'
          } ${!canShareVideo ? 'opacity-45 cursor-not-allowed' : ''}`}
          title={cameraEnabled ? 'Stop Camera' : 'Start Camera'}
        >
          {cameraEnabled ? <VideoOff className="w-3.5 h-3.5" /> : <Video className="w-3.5 h-3.5" />}
        </button>

        <button
          onClick={() => {
            void toggleScreenShare()
          }}
          disabled={!canShareVideo}
          className={`flex-1 py-1.5 rounded-lg flex items-center justify-center gap-1.5 text-xs font-medium transition-all ${
            screenShareEnabled
              ? 'bg-emerald-600/20 text-emerald-300'
              : 'bg-bg-tertiary/50 text-text-muted hover:text-text-primary hover:bg-bg-tertiary'
          } ${!canShareVideo ? 'opacity-45 cursor-not-allowed' : ''}`}
          title={screenShareEnabled ? 'Stop Screen Share' : 'Start Screen Share'}
        >
          {screenShareEnabled
            ? <ScreenShareOff className="w-3.5 h-3.5" />
            : <ScreenShare className="w-3.5 h-3.5" />}
        </button>

        <button
          onClick={disconnect}
          className="px-3 py-1.5 rounded-lg bg-red-600/20 text-red-400 hover:bg-red-600/30 flex items-center justify-center transition-colors"
          title="Disconnect"
        >
          <PhoneOff className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}
