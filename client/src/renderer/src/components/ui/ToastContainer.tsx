import { useEffect, useState } from 'react'
import { CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { useToastStore, type Toast } from '../../stores/toastStore'

const ICONS = {
  info: Info,
  success: CheckCircle2,
  error: XCircle
}

function ToastItem({ toast }: { toast: Toast }): React.JSX.Element {
  const removeToast = useToastStore((s) => s.removeToast)
  const [exiting, setExiting] = useState(false)

  useEffect(() => {
    if (toast.duration <= 0) return

    const exitTimer = setTimeout(() => setExiting(true), toast.duration - 300)
    return () => clearTimeout(exitTimer)
  }, [toast.duration])

  const Icon = ICONS[toast.type]

  return (
    <div
      className={`vesper-toast vesper-toast-${toast.type}${exiting ? ' vesper-toast-exit' : ''}`}
      role="status"
      aria-live="polite"
    >
      <Icon className="vesper-toast-icon" />
      <span className="vesper-toast-message">{toast.message}</span>
      <button
        type="button"
        className="vesper-toast-close"
        onClick={() => removeToast(toast.id)}
        aria-label="Dismiss"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

export default function ToastContainer(): React.JSX.Element | null {
  const toasts = useToastStore((s) => s.toasts)

  if (toasts.length === 0) return null

  return (
    <div className="vesper-toast-container" aria-label="Notifications">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  )
}
