import { Editor, Transforms, Range, Element, Node } from 'slate'

/**
 * Enter submits the message (calls onSubmit callback).
 * Shift+Enter inserts a new line element.
 */
export function withSoftBreak(
  editor: Editor,
  onSubmit: () => void
): Editor {
  const { insertBreak } = editor

  editor.insertBreak = () => {
    // Shift+Enter is handled by the keydown handler in VesperEditable
    // which calls editor.insertBreak() directly. This default path is
    // for the normal Enter case, which Slate calls via insertBreak.
    // We override to insert a new line element instead of splitting.
    const { selection } = editor
    if (!selection) return

    // Delete any selected content first
    if (!Range.isCollapsed(selection)) {
      Transforms.delete(editor)
    }

    // Insert a new line element
    Transforms.insertNodes(editor, {
      type: 'line',
      children: [{ text: '' }],
    })
  }

  return editor
}
