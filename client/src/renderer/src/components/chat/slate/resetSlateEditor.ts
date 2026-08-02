import { Editor, Transforms, Node } from 'slate'
import { emptyDocument } from './types'

export function resetSlateEditor(editor: Editor): void {
  Transforms.delete(editor, {
    at: {
      anchor: Editor.start(editor, []),
      focus: Editor.end(editor, []),
    },
  })

  while (editor.children.length > 1) {
    Transforms.removeNodes(editor, { at: [editor.children.length - 1] })
  }

  const remaining = editor.children[0]
  if (!remaining || !('children' in remaining) || Node.string(remaining) !== '') {
    if (remaining) {
      Transforms.removeNodes(editor, { at: [0] })
    }
    Transforms.insertNodes(editor, emptyDocument()[0], { at: [0] })
  }

  Transforms.select(editor, Editor.start(editor, []))
}
