import { type Editor, Element, Transforms } from 'slate'
import { VOID_TYPES, INLINE_TYPES } from '../types'

export function withInlineVoids(editor: Editor): Editor {
  const { isInline, isVoid, normalizeNode } = editor

  editor.isInline = (element) => {
    if (INLINE_TYPES.has(element.type)) return true
    return isInline(element)
  }

  editor.isVoid = (element) => {
    if (VOID_TYPES.has(element.type)) return true
    return isVoid(element)
  }

  // Safety net: if an inline void somehow ends up as a direct child
  // of the editor (top-level), wrap it in a line element.
  editor.normalizeNode = (entry) => {
    const [node, path] = entry
    if (
      path.length === 1 &&
      Element.isElement(node) &&
      INLINE_TYPES.has(node.type)
    ) {
      Transforms.wrapNodes(
        editor,
        { type: 'line', children: [] },
        { at: path }
      )
      return
    }
    normalizeNode(entry)
  }

  return editor
}
