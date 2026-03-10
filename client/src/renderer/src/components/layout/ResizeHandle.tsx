import { useRef, useState } from 'react'

interface Props {
  side: 'left' | 'right'
  onResizeDelta: (delta: number) => void
}

export default function ResizeHandle({ side, onResizeDelta }: Props): React.JSX.Element {
  const lastXRef = useRef<number | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    lastXRef.current = event.clientX
    setIsDragging(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handleMouseMove = (moveEvent: MouseEvent): void => {
      if (lastXRef.current === null) {
        return
      }

      const delta = moveEvent.clientX - lastXRef.current
      lastXRef.current = moveEvent.clientX
      onResizeDelta(side === 'right' ? delta : -delta)
    }

    const handleMouseUp = (): void => {
      lastXRef.current = null
      setIsDragging(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
  }

  return (
    <div
      className={
        side === 'right'
          ? `vesper-resize-handle vesper-resize-handle-right${isDragging ? ' vesper-resize-handle-dragging' : ''}`
          : `vesper-resize-handle vesper-resize-handle-left${isDragging ? ' vesper-resize-handle-dragging' : ''}`
      }
      onMouseDown={handleMouseDown}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
    />
  )
}
