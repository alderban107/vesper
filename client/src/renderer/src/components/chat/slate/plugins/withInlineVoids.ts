import type { Editor } from 'slate'
import { VOID_TYPES, INLINE_TYPES } from '../types'

export function withInlineVoids(editor: Editor): Editor {
  const { isInline, isVoid } = editor

  editor.isInline = (element) =>
    INLINE_TYPES.has(element.type) || isInline(element)

  editor.isVoid = (element) =>
    VOID_TYPES.has(element.type) || isVoid(element)

  return editor
}
