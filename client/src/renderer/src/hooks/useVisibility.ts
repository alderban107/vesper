import { useCallback, useEffect, useRef, useState } from 'react'

interface UseVisibilityResult {
  /** Ref to attach to the observed DOM element */
  ref: (node: HTMLElement | null) => void
  /** Whether the element is currently within the viewport + root margin */
  isVisible: boolean
  /** Whether the element has ever been visible (sticky true once set) */
  hasBeenVisible: boolean
  /** Whether the element has scrolled far enough away to warrant memory eviction */
  isFarAway: boolean
}

/**
 * Observes an element's intersection with the viewport.
 *
 * - `rootMargin` of 600px so we detect elements before they scroll into view,
 *    allowing pre-load to start early.
 * - A second observer with 2000px margin detects when an element has scrolled
 *   far out of view, signalling the caller to revoke blob URLs and free memory.
 */
export function useVisibility(): UseVisibilityResult {
  const [isVisible, setIsVisible] = useState(false)
  const [hasBeenVisible, setHasBeenVisible] = useState(false)
  const [isFarAway, setIsFarAway] = useState(false)

  const elementRef = useRef<HTMLElement | null>(null)
  const preloadObserverRef = useRef<IntersectionObserver | null>(null)
  const evictionObserverRef = useRef<IntersectionObserver | null>(null)

  // Clean up observers on unmount
  useEffect(() => {
    return () => {
      preloadObserverRef.current?.disconnect()
      evictionObserverRef.current?.disconnect()
    }
  }, [])

  const ref = useCallback((node: HTMLElement | null) => {
    // Disconnect previous observers
    preloadObserverRef.current?.disconnect()
    evictionObserverRef.current?.disconnect()

    elementRef.current = node
    if (!node) return

    // Pre-load observer: 600px margin
    preloadObserverRef.current = new IntersectionObserver(
      ([entry]) => {
        const visible = entry.isIntersecting
        setIsVisible(visible)
        if (visible) {
          setHasBeenVisible(true)
        }
      },
      { rootMargin: '600px' }
    )
    preloadObserverRef.current.observe(node)

    // Eviction observer: 2000px margin — when element leaves this larger zone,
    // it's far away enough to evict from memory
    evictionObserverRef.current = new IntersectionObserver(
      ([entry]) => {
        // isFarAway = element is outside the 2000px margin
        setIsFarAway(!entry.isIntersecting)
      },
      { rootMargin: '2000px' }
    )
    evictionObserverRef.current.observe(node)
  }, [])

  return { ref, isVisible, hasBeenVisible, isFarAway }
}
