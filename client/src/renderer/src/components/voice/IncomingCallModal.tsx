import { useEffect, useState } from 'react'
import { Phone, PhoneOff } from 'lucide-react'
import { useVoiceStore } from '../../stores/voiceStore'
import { useDmStore } from '../../stores/dmStore'
import { useAuthStore } from '../../stores/authStore'

export default function IncomingCallModal(): React.JSX.Element | null {
  const incomingCall = useVoiceStore((s) => s.incomingCall)
  const acceptCall = useVoiceStore((s) => s.acceptCall)
  const rejectCall = useVoiceStore((s) => s.rejectCall)
  const conversations = useDmStore((s) => s.conversations)
  const currentUserId = useAuthStore((s) => s.user?.id)

  const [countdown, setCountdown] = useState(30)

  useEffect(() => {
    if (!incomingCall) return

    setCountdown(30)
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          rejectCall()
          return 0
        }
        return prev - 1
      })
    }, 1000)

    try {
      window.electron.ipcRenderer.invoke('voice:showCallNotification', {
        callerId: incomingCall.callerId,
        conversationId: incomingCall.conversationId
      })
    } catch {
      // Notification not available
    }

    return () => clearInterval(interval)
  }, [incomingCall, rejectCall])

  if (!incomingCall) return null

  const conversation = conversations.find((c) => c.id === incomingCall.conversationId)
  const callerName = (() => {
    if (!conversation) return 'Unknown'
    const caller = conversation.participants.find(
      (p) => p.user_id === incomingCall.callerId
    )
    if (caller) return caller.user.display_name || caller.user.username
    return 'Unknown'
  })()

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="glass-card rounded-2xl p-8 w-80 flex flex-col items-center gap-6 animate-scale-in">
        {/* Avatar with pulse ring */}
        <div className="relative">
          <div className="w-16 h-16 rounded-full bg-accent/20 flex items-center justify-center text-2xl text-accent font-semibold animate-pulse-ring">
            {callerName.slice(0, 2).toUpperCase()}
          </div>
        </div>

        <div className="text-center">
          <p className="text-text-primary text-lg font-semibold">{callerName}</p>
          <p className="text-text-muted text-sm">Incoming voice call...</p>
          <p className="text-text-faint text-xs mt-1">{countdown}s</p>
        </div>

        <div className="flex gap-4">
          <button
            onClick={() => rejectCall()}
            className="w-14 h-14 rounded-full bg-red-600/20 hover:bg-red-600/30 text-red-400 flex items-center justify-center transition-colors"
            title="Reject"
          >
            <PhoneOff className="w-6 h-6" />
          </button>
          <button
            onClick={() => acceptCall(incomingCall.conversationId)}
            className="w-14 h-14 rounded-full bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 flex items-center justify-center transition-colors shadow-[0_0_16px_rgba(52,211,153,0.2)]"
            title="Accept"
          >
            <Phone className="w-6 h-6" />
          </button>
        </div>
      </div>
    </div>
  )
}
