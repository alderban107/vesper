import { Editor, Node } from 'slate'

const MAX_MESSAGE_LENGTH = 4000

/**
 * Prevents inserting text that would exceed the message length limit.
 */
export function withMaxLength(editor: Editor): Editor {
  const { insertText, insertFragment } = editor

  editor.insertText = (text) => {
    const currentLength = Editor.string(editor, []).length
    if (currentLength + text.length > MAX_MESSAGE_LENGTH) {
      const remaining = MAX_MESSAGE_LENGTH - currentLength
      if (remaining > 0) {
        insertText(text.slice(0, remaining))
      }
      return
    }
    insertText(text)
  }

  return editor
}
