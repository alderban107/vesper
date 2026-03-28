import { Editor, Transforms, Range } from 'slate'
import type { ComposerAutocompleteItem } from '../ComposerAutocomplete'

/**
 * Insert a void node from autocomplete selection into the Slate editor.
 * Deletes the trigger text (e.g. "@query") and inserts the appropriate void element.
 */
export function insertAutocompleteResult(
  editor: Editor,
  item: ComposerAutocompleteItem,
  triggerStart: number
): void {
  const { selection } = editor
  if (!selection || !Range.isCollapsed(selection)) return

  const focus = selection.focus
  // Delete from trigger start to current cursor
  const deleteRange = {
    anchor: { path: focus.path, offset: triggerStart },
    focus,
  }
  Transforms.delete(editor, { at: deleteRange })

  if (item.type === 'user') {
    Transforms.insertNodes(editor, {
      type: 'user-mention',
      userId: item.id,
      displayName: item.label,
      children: [{ text: '' }],
    })
  } else if (item.type === 'everyone') {
    Transforms.insertNodes(editor, {
      type: 'user-mention',
      userId: 'everyone',
      displayName: 'everyone',
      children: [{ text: '' }],
    })
  } else if (item.type === 'channel') {
    Transforms.insertNodes(editor, {
      type: 'channel-mention',
      channelId: item.id,
      channelName: item.label,
      children: [{ text: '' }],
    })
  } else if (item.type === 'emoji' && item.emojiGlyph) {
    Transforms.insertNodes(editor, {
      type: 'emoji',
      unicode: item.emojiGlyph,
      children: [{ text: '' }],
    })
  }

  // Insert trailing space and move cursor after it
  Transforms.insertText(editor, ' ')
}

/**
 * Detect autocomplete trigger from Slate editor state.
 * Walks backward from cursor to find @, #, or : trigger characters.
 */
export function detectSlateTrigger(
  editor: Editor
): { type: 'mention' | 'channel' | 'emoji'; query: string; start: number } | null {
  const { selection } = editor
  if (!selection || !Range.isCollapsed(selection)) return null

  const [start] = Range.edges(selection)

  // Get the text node at cursor
  const [node] = Editor.node(editor, start.path)
  if (!('text' in node)) return null

  const textBeforeCursor = node.text.slice(0, start.offset)

  // Walk backward to find a trigger character
  for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
    const ch = textBeforeCursor[i]

    // Stop at whitespace — no trigger across word boundaries
    if (/\s/.test(ch)) return null

    if (ch === '@') {
      return {
        type: 'mention',
        query: textBeforeCursor.slice(i + 1),
        start: i,
      }
    }
    if (ch === '#') {
      return {
        type: 'channel',
        query: textBeforeCursor.slice(i + 1),
        start: i,
      }
    }
    if (ch === ':' && i < textBeforeCursor.length - 1) {
      const query = textBeforeCursor.slice(i + 1)
      if (query.length >= 2) {
        return { type: 'emoji', query, start: i }
      }
    }
  }

  return null
}
