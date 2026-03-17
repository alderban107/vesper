import { useState, useCallback } from 'react'

interface ContextMenuState<T> {
  x?: number
  y: number
  anchorRect?: DOMRect | null
  data: T
}

interface UseContextMenuReturn<T> {
  menu: ContextMenuState<T> | null
  onContextMenu: (e: React.MouseEvent, data: T) => void
  openFromElement: (element: HTMLElement, data: T) => void
  closeMenu: () => void
}

export function useContextMenu<T>(): UseContextMenuReturn<T> {
  const [menu, setMenu] = useState<ContextMenuState<T> | null>(null)

  const onContextMenu = useCallback((e: React.MouseEvent, data: T) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, data })
  }, [])

  const openFromElement = useCallback((element: HTMLElement, data: T) => {
    const rect = element.getBoundingClientRect()
    setMenu({
      y: rect.bottom,
      anchorRect: rect,
      data
    })
  }, [])

  const closeMenu = useCallback(() => setMenu(null), [])

  return { menu, onContextMenu, openFromElement, closeMenu }
}
