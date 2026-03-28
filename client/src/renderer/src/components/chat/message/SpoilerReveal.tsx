import { useState, useCallback } from 'react'

interface Props {
  children: React.ReactNode
}

export default function SpoilerReveal({ children }: Props): React.JSX.Element {
  const [revealed, setRevealed] = useState(false)

  const handleClick = useCallback(() => {
    setRevealed((prev) => !prev)
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setRevealed((prev) => !prev)
    }
  }, [])

  return (
    <span
      className={revealed ? 'vesper-spoiler vesper-spoiler-revealed' : 'vesper-spoiler vesper-spoiler-hidden'}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-label={revealed ? 'Spoiler revealed' : 'Spoiler — click to reveal'}
    >
      <span className="vesper-spoiler-content">
        {children}
      </span>
    </span>
  )
}
