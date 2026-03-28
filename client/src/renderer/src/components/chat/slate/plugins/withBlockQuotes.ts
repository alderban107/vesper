import { Editor, Transforms, Element, Node, Range, Point } from 'slate'

/**
 * Minimal blockquote support — just handles backspace at the start of a
 * line beginning with "> " to remove the prefix. Everything else is
 * handled by the decoration system (visual styling of > lines).
 */
export function withBlockQuotes(editor: Editor): Editor {
  // No-op — blockquotes are now purely decorative (handled by decorations.ts).
  // The > prefix stays as plain text in the document.
  return editor
}
