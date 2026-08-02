import { useEffect } from 'react'
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import ServerConnectionCard from './ServerConnectionCard'

interface Props {
  onClose: () => void
}

export default function AuthServerSettingsModal({ onClose }: Props): React.JSX.Element {
  const modalRef = useFocusTrap<HTMLDivElement>(true)
  useBodyScrollLock()

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div
      className="vesper-auth-server-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Server settings"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div ref={modalRef} className="vesper-auth-server-modal">
        <ServerConnectionCard onSave={onClose} />
      </div>
    </div>
  )
}
