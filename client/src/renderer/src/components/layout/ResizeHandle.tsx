import { useRef, useState } from 'react'

interface Props {
  side: 'left' | 'right'
  width: number
  onWidthChange: (nextWidth: number) => void
}

export default function ResizeHandle({ side, width, onWidthChange }: Props): React.JSX.Element {
  const startXRef = useRef<number | null>(null)
  const startWidthRef = useRef<number>(width)
  const [isDragging, setIsDragging] = useState(false)

  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    startXRef.current = event.clientX
    startWidthRef.current = width
    setIsDragging(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handleMouseMove = (moveEvent: MouseEvent): void => {
      if (startXRef.current === null) {
        return
      }

      const delta = moveEvent.clientX - startXRef.current
      const signedDelta = side === 'right' ? delta : -delta
      onWidthChange(startWidthRef.current + signedDelta)
    }

    const handleMouseUp = (): void => {
      startXRef.current = null
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
      tabIndex={0}
    />
  )
}
