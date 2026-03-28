import { Editor, Transforms, Element, Node, Range, Point } from 'slate'

/**
 * Handles `> ` at the start of a line to create a blockquote element.
 * Enter inside a blockquote continues it. Enter on empty blockquote line exits.
 */
export function withBlockQuotes(editor: Editor): Editor {
  const { insertText, insertBreak, deleteBackward } = editor

  editor.insertText = (text) => {
    const { selection } = editor
    if (text === ' ' && selection && Range.isCollapsed(selection)) {
      const [node, path] = Editor.node(editor, selection.focus.path)
      if ('text' in node && node.text === '>' && selection.focus.offset === 1) {
        // User typed "> " — convert line to blockquote
        const linePath = path.slice(0, -1)
        const [lineNode] = Editor.node(editor, linePath)
        if (Element.isElement(lineNode) && lineNode.type === 'line') {
          // Delete the ">" text
          Transforms.delete(editor, {
            at: { anchor: { path, offset: 0 }, focus: { path, offset: 1 } }
          })
          // Wrap in blockquote
          Transforms.wrapNodes(
            editor,
            { type: 'blockquote', children: [] },
            { at: linePath }
          )
          return
        }
      }
    }
    insertText(text)
  }

  editor.insertBreak = () => {
    const { selection } = editor
    if (selection && Range.isCollapsed(selection)) {
      const [match] = Editor.nodes(editor, {
        match: (n) => Element.isElement(n) && n.type === 'blockquote',
      })
      if (match) {
        const [, blockquotePath] = match
        // If current line is empty inside blockquote, exit the blockquote
        const [lineNode] = Editor.node(editor, selection.focus.path.slice(0, -1))
        if (Element.isElement(lineNode) && Node.string(lineNode) === '') {
          // Unwrap from blockquote and insert a new line after
          Transforms.unwrapNodes(editor, {
            match: (n) => Element.isElement(n) && n.type === 'blockquote',
            split: true,
          })
          return
        }
      }
    }
    insertBreak()
  }

  editor.deleteBackward = (unit) => {
    const { selection } = editor
    if (selection && Range.isCollapsed(selection)) {
      const [match] = Editor.nodes(editor, {
        match: (n) => Element.isElement(n) && n.type === 'blockquote',
      })
      if (match) {
        const [, blockquotePath] = match
        // If at start of blockquote content, unwrap
        const start = Editor.start(editor, blockquotePath)
        if (Point.equals(selection.focus, start)) {
          Transforms.unwrapNodes(editor, {
            match: (n) => Element.isElement(n) && n.type === 'blockquote',
            split: true,
          })
          return
        }
      }
    }
    deleteBackward(unit)
  }

  return editor
}
