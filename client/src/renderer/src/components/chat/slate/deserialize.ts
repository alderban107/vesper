import type { Descendant } from 'slate'

const MENTION_REGEX = /<@([0-9a-f-]{36}|everyone)>/g
const CHANNEL_REGEX = /<#([0-9a-f-]{36})>/g
const CUSTOM_EMOJI_REGEX = /<(a?):([a-zA-Z0-9_~-]{2,32}):([a-zA-Z0-9_-]+)>/g

interface MemberLookup {
  get(userId: string): { displayName: string } | undefined
}

interface ChannelLookup {
  get(channelId: string): { name: string } | undefined
}

/**
 * Deserialize a markdown string (with wire tokens) into a Slate document.
 * Used for editing existing messages.
 *
 * For now, handles line splitting and basic token replacement.
 * Void nodes (mentions, emoji) are inserted as inline elements.
 */
export function deserializeMarkdown(
  markdown: string,
  members?: MemberLookup,
  channels?: ChannelLookup
): Descendant[] {
  const lines = markdown.split('\n')
  const result: Descendant[] = []

  for (const line of lines) {
    const children: Descendant[] = []
    let remaining = line
    let lastIndex = 0

    // Combine all token patterns and process in order
    const tokens: Array<{
      index: number
      length: number
      node: Descendant
    }> = []

    // Find mentions
    for (const match of line.matchAll(MENTION_REGEX)) {
      const userId = match[1]
      if (userId === 'everyone') {
        tokens.push({
          index: match.index!,
          length: match[0].length,
          node: {
            type: 'user-mention',
            userId: 'everyone',
            displayName: 'everyone',
            children: [{ text: '' }],
          },
        })
      } else {
        const member = members?.get(userId)
        tokens.push({
          index: match.index!,
          length: match[0].length,
          node: {
            type: 'user-mention',
            userId,
            displayName: member?.displayName ?? userId.slice(0, 8),
            children: [{ text: '' }],
          },
        })
      }
    }

    // Find channels
    for (const match of line.matchAll(CHANNEL_REGEX)) {
      const channelId = match[1]
      const channel = channels?.get(channelId)
      tokens.push({
        index: match.index!,
        length: match[0].length,
        node: {
          type: 'channel-mention',
          channelId,
          channelName: channel?.name ?? channelId.slice(0, 8),
          children: [{ text: '' }],
        },
      })
    }

    // Sort tokens by position
    tokens.sort((a, b) => a.index - b.index)

    // Build children array with text between tokens
    let cursor = 0
    for (const token of tokens) {
      if (token.index > cursor) {
        children.push({ text: line.slice(cursor, token.index) })
      }
      children.push(token.node)
      cursor = token.index + token.length
    }

    // Add remaining text
    if (cursor < line.length) {
      children.push({ text: line.slice(cursor) })
    }

    // Ensure at least one child
    if (children.length === 0) {
      children.push({ text: '' })
    }

    result.push({ type: 'line', children })
  }

  return result.length > 0 ? result : [{ type: 'line', children: [{ text: '' }] }]
}
