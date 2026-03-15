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
  const conversationLabel = conversation?.name
    || conversation?.participants
      .filter((participant) => participant.user_id !== currentUserId)
      .map((participant) => participant.user.display_name || participant.user.username)
      .join(', ')
    || 'Direct message'
  const callerName = (() => {
    if (!conversation) return 'Unknown'
    const caller = conversation.participants.find(
      (p) => p.user_id === incomingCall.callerId
    )
    if (caller) return caller.user.display_name || caller.user.username
    return 'Unknown'
  })()

  return (
    <div className="vesper-incoming-call-shell">
      <div className="vesper-incoming-call-card glass-card animate-scale-in">
        <div className="vesper-incoming-call-avatar">
          <div className="vesper-incoming-call-avatar-ring">
            {callerName.slice(0, 2).toUpperCase()}
          </div>
        </div>

        <div className="vesper-incoming-call-copy">
          <p className="vesper-incoming-call-kicker">Incoming voice call</p>
          <p className="vesper-incoming-call-title">{callerName}</p>
          <p className="vesper-incoming-call-subtitle">{conversationLabel}</p>
          <p className="vesper-incoming-call-timer">Ringing for {countdown}s</p>
        </div>

        <div className="vesper-incoming-call-actions">
          <button
            onClick={() => rejectCall()}
            className="vesper-incoming-call-button vesper-incoming-call-button-decline"
            title="Decline"
          >
            <span className="vesper-incoming-call-button-icon">
              <PhoneOff className="w-5 h-5" />
            </span>
            <span>Decline</span>
          </button>
          <button
            onClick={() => acceptCall(incomingCall.conversationId)}
            className="vesper-incoming-call-button vesper-incoming-call-button-accept"
            title="Accept"
          >
            <span className="vesper-incoming-call-button-icon">
              <Phone className="w-5 h-5" />
            </span>
            <span>Accept</span>
          </button>
        </div>
      </div>
    </div>
  )
}
