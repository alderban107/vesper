import { useState, useRef, useEffect } from 'react'
import { Timer } from 'lucide-react'
import { pushToChannel } from '../../api/socket'

const TTL_OPTIONS = [
  { label: 'Off', value: null },
  { label: '1 hour', value: 3600 },
  { label: '24 hours', value: 86400 },
  { label: '7 days', value: 604800 },
  { label: '30 days', value: 2592000 }
] as const

interface Props {
  currentTtl: number | null
  topic: string
}

function formatTtl(ttl: number | null): string {
  if (!ttl) return 'Off'
  const opt = TTL_OPTIONS.find((o) => o.value === ttl)
  return opt?.label ?? `${ttl}s`
}

export default function DisappearingSettings({ currentTtl, topic }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const setTtl = (ttl: number | null): void => {
    pushToChannel(topic, 'set_disappearing', { ttl })
    setOpen(false)
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="text-text-muted hover:text-text-primary transition-colors flex items-center gap-1 p-1.5 rounded hover:bg-bg-tertiary/50"
        title="Disappearing messages"
      >
        <Timer className="w-4 h-4" />
        {currentTtl && <span className="text-xs">{formatTtl(currentTtl)}</span>}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 glass-card rounded-xl py-1 z-50 min-w-[160px] animate-scale-in">
          <div className="px-3 py-1.5 text-text-faint text-xs font-medium uppercase tracking-wide">
            Disappearing Messages
          </div>
          {TTL_OPTIONS.map((opt) => (
            <button
              key={opt.label}
              onClick={() => setTtl(opt.value)}
              className={`w-full text-left px-3 py-1.5 text-sm hover:bg-bg-tertiary/30 transition-colors ${
                currentTtl === opt.value
                  ? 'text-accent font-medium'
                  : 'text-text-secondary'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
