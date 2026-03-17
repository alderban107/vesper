import { createPortal } from 'react-dom'
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject
} from 'react'

type Placement =
  | 'top-start'
  | 'top-end'
  | 'bottom-start'
  | 'bottom-end'
  | 'right-start'
  | 'right-center'
  | 'left-start'
  | 'left-center'

interface PointAnchor {
  x: number
  y: number
}

interface Props {
  children: ReactNode
  anchorRef?: RefObject<HTMLElement | null>
  anchorRect?: DOMRect | null
  point?: PointAnchor | null
  placement?: Placement
  offset?: number
  minWidth?: number | 'anchor'
  maxWidth?: number
  onClose?: () => void
  closeOnEscape?: boolean
  closeOnPointerDownOutside?: boolean
  className?: string
  zIndex?: number
  ariaLabel?: string
  role?: string
}

const VIEWPORT_PADDING = 12

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function resolveAnchorRect(
  anchorRef?: RefObject<HTMLElement | null>,
  anchorRect?: DOMRect | null,
  point?: PointAnchor | null
): DOMRect | null {
  if (point) {
    return new DOMRect(point.x, point.y, 0, 0)
  }

  if (anchorRect) {
    return anchorRect
  }

  return anchorRef?.current?.getBoundingClientRect() ?? null
}

export default function FloatingSurface({
  children,
  anchorRef,
  anchorRect,
  point,
  placement = 'bottom-start',
  offset = 10,
  minWidth,
  maxWidth,
  onClose,
  closeOnEscape = true,
  closeOnPointerDownOutside = true,
  className,
  zIndex = 80,
  ariaLabel,
  role
}: Props): React.JSX.Element | null {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties | null>(null)
  const ignoreNode = anchorRef?.current ?? null

  const resolvedMinWidth = useMemo(() => {
    const rect = resolveAnchorRect(anchorRef, anchorRect, point)
    if (minWidth === 'anchor') {
      return rect?.width ?? undefined
    }
    return minWidth
  }, [anchorRect, anchorRef, minWidth, point])

  useLayoutEffect(() => {
    const updatePosition = (): void => {
      const anchor = resolveAnchorRect(anchorRef, anchorRect, point)
      const surface = surfaceRef.current
      if (!anchor || !surface) {
        setStyle(null)
        return
      }

      const rect = surface.getBoundingClientRect()
      const width = maxWidth ? Math.min(rect.width || 0, maxWidth) || maxWidth : rect.width
      const height = rect.height
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight

      let left = anchor.left
      let top = anchor.bottom + offset

      switch (placement) {
        case 'top-start':
          left = anchor.left
          top = anchor.top - height - offset
          break
        case 'top-end':
          left = anchor.right - width
          top = anchor.top - height - offset
          break
        case 'bottom-end':
          left = anchor.right - width
          top = anchor.bottom + offset
          break
        case 'right-start':
          left = anchor.right + offset
          top = anchor.top
          break
        case 'right-center':
          left = anchor.right + offset
          top = anchor.top + (anchor.height - height) / 2
          break
        case 'left-start':
          left = anchor.left - width - offset
          top = anchor.top
          break
        case 'left-center':
          left = anchor.left - width - offset
          top = anchor.top + (anchor.height - height) / 2
          break
        case 'bottom-start':
        default:
          left = anchor.left
          top = anchor.bottom + offset
          break
      }

      if (placement.startsWith('top') && top < VIEWPORT_PADDING) {
        top = Math.min(anchor.bottom + offset, viewportHeight - height - VIEWPORT_PADDING)
      }

      if (placement.startsWith('bottom') && top + height > viewportHeight - VIEWPORT_PADDING) {
        const fallbackTop = anchor.top - height - offset
        if (fallbackTop >= VIEWPORT_PADDING) {
          top = fallbackTop
        }
      }

      left = clamp(left, VIEWPORT_PADDING, Math.max(VIEWPORT_PADDING, viewportWidth - width - VIEWPORT_PADDING))
      top = clamp(top, VIEWPORT_PADDING, Math.max(VIEWPORT_PADDING, viewportHeight - height - VIEWPORT_PADDING))

      setStyle({
        position: 'fixed',
        left,
        top,
        minWidth: resolvedMinWidth,
        maxWidth,
        zIndex
      })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)

    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [anchorRect, anchorRef, maxWidth, offset, placement, point, resolvedMinWidth])

  useEffect(() => {
    if (!onClose) {
      return
    }

    const handlePointerDown = (event: PointerEvent): void => {
      if (!closeOnPointerDownOutside) {
        return
      }

      const target = event.target as Node | null
      if (!target) {
        return
      }

      if (surfaceRef.current?.contains(target)) {
        return
      }

      if (ignoreNode?.contains(target)) {
        return
      }

      onClose()
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (closeOnEscape && event.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [closeOnEscape, closeOnPointerDownOutside, ignoreNode, onClose])

  if (typeof document === 'undefined') {
    return null
  }

  return createPortal(
    <div
      ref={surfaceRef}
      className={className}
      role={role}
      aria-label={ariaLabel}
      style={style ?? { visibility: 'hidden' }}
    >
      {children}
    </div>,
    document.body
  )
}
