import { useState, useCallback } from 'react'

interface ContextMenuState<T> {
  x: number
  y: number
  data: T
}

interface UseContextMenuReturn<T> {
  menu: ContextMenuState<T> | null
  onContextMenu: (e: React.MouseEvent, data: T) => void
  closeMenu: () => void
}

export function useContextMenu<T>(): UseContextMenuReturn<T> {
  const [menu, setMenu] = useState<ContextMenuState<T> | null>(null)

  const onContextMenu = useCallback((e: React.MouseEvent, data: T) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, data })
  }, [])

  const closeMenu = useCallback(() => setMenu(null), [])

  return { menu, onContextMenu, closeMenu }
}
