import { Editor, Transforms, Element, Node, Range, Point } from 'slate'

/**
 * Handles ``` fence lines to enter/exit code blocks.
 * When user types ``` on its own line, creates a code-block element.
 * When user types ``` again on its own line inside code block, exits it.
 */
export function withCodeBlocks(editor: Editor): Editor {
  const { insertText } = editor

  editor.insertText = (text) => {
    const { selection } = editor
    if (text === '`' && selection && Range.isCollapsed(selection)) {
      const [node, path] = Editor.node(editor, selection.focus.path)
      if ('text' in node) {
        const textBefore = node.text.slice(0, selection.focus.offset)
        const linePath = path.slice(0, -1)
        const [lineNode] = Editor.node(editor, linePath)

        // Check if we're inside a code block and typing the closing fence
        const [codeBlockMatch] = Editor.nodes(editor, {
          match: (n) => Element.isElement(n) && n.type === 'code-block',
        })

        if (codeBlockMatch) {
          // Inside code block — check for closing ```
          if (textBefore === '``') {
            // Delete the `` and unwrap the code block
            Transforms.delete(editor, {
              at: { anchor: { path, offset: 0 }, focus: { path, offset: 2 } }
            })
            Transforms.unwrapNodes(editor, {
              match: (n) => Element.isElement(n) && n.type === 'code-block',
              split: true,
            })
            // Convert code-block-line back to regular line
            Transforms.setNodes(editor, { type: 'line' } as Partial<Element>, {
              match: (n) => Element.isElement(n) && n.type === 'code-block-line',
            })
            return
          }
        } else if (textBefore === '``' && Element.isElement(lineNode) && lineNode.type === 'line') {
          // Not in code block, typed ``` — detect language and create code block
          // Delete the `` prefix
          Transforms.delete(editor, {
            at: { anchor: { path, offset: 0 }, focus: { path, offset: 2 } }
          })
          // Convert line to code-block-line and wrap in code-block
          Transforms.setNodes(editor, { type: 'code-block-line' } as Partial<Element>, {
            at: linePath,
          })
          Transforms.wrapNodes(
            editor,
            { type: 'code-block', language: '', children: [] },
            { at: linePath }
          )
          return
        }
      }
    }
    insertText(text)
  }

  return editor
}
