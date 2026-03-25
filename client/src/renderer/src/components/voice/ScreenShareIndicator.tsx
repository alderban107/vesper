import { ScreenShareOff } from 'lucide-react'
import { useVoiceStore } from '../../stores/voiceStore'

export default function ScreenShareIndicator(): React.JSX.Element | null {
  const screenShareEnabled = useVoiceStore((s) => s.screenShareEnabled)
  const toggleScreenShare = useVoiceStore((s) => s.toggleScreenShare)

  if (!screenShareEnabled) return null

  return (
    <div className="vesper-screen-share-indicator">
      <span className="vesper-screen-share-indicator-text">You are sharing your screen</span>
      <button
        type="button"
        onClick={() => toggleScreenShare()}
        className="vesper-screen-share-indicator-stop"
      >
        <ScreenShareOff className="w-4 h-4" />
        Stop Sharing
      </button>
    </div>
  )
}
