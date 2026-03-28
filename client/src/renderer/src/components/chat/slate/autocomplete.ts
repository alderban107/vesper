import { Editor, Transforms, Range, Node, Text } from 'slate'
import type { ComposerAutocompleteItem } from '../ComposerAutocomplete'
import type { CustomElement } from './types'

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

  let node: CustomElement | null = null

  if (item.type === 'user') {
    node = {
      type: 'user-mention',
      userId: item.id,
      displayName: item.label,
      children: [{ text: '' }],
    }
  } else if (item.type === 'everyone') {
    node = {
      type: 'user-mention',
      userId: 'everyone',
      displayName: 'everyone',
      children: [{ text: '' }],
    }
  } else if (item.type === 'channel') {
    node = {
      type: 'channel-mention',
      channelId: item.id,
      channelName: item.label,
      children: [{ text: '' }],
    }
  } else if (item.type === 'emoji' && item.emojiGlyph) {
    node = {
      type: 'emoji',
      unicode: item.emojiGlyph,
      children: [{ text: '' }],
    }
  }

  if (node) {
    Transforms.insertNodes(editor, [node, { text: ' ' }])
    // Move cursor to after the space
    Transforms.move(editor, { distance: 1 })
  }
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
  const entry = Editor.node(editor, start.path)
  const node = entry[0]
  if (!Text.isText(node)) return null

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
    if (ch === ':') {
      const query = textBeforeCursor.slice(i + 1)
      return { type: 'emoji', query, start: i }
    }
  }

  return null
}
