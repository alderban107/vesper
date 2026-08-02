import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function useFocusTrap<T extends HTMLElement>(
  active: boolean
): RefObject<T | null> {
  const ref = useRef<T | null>(null)
  const previousFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!active || !ref.current) return

    previousFocus.current = document.activeElement as HTMLElement
    const container = ref.current

    const focusableElements = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))

    // Preserve an element's native autofocus when it is already inside the dialog.
    const elements = focusableElements()
    if (!container.contains(document.activeElement) && elements.length > 0) {
      elements[0].focus()
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return

      const els = focusableElements()
      if (els.length === 0) return

      const first = els[0]
      const last = els[els.length - 1]

      if (event.shiftKey) {
        if (document.activeElement === first) {
          event.preventDefault()
          last.focus()
        }
      } else {
        if (document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }

    container.addEventListener('keydown', handleKeyDown)

    return () => {
      container.removeEventListener('keydown', handleKeyDown)
      previousFocus.current?.focus()
    }
  }, [active])

  return ref
}
