import { Node, type Descendant } from 'slate'

/**
 * Serialize a Slate document to a markdown string.
 * Because we use the decorations-only approach, text nodes contain raw
 * markdown syntax. We just need to concatenate text and convert void
 * nodes to their wire tokens.
 */
export function serializeToMarkdown(nodes: Descendant[]): string {
  return nodes.map(serializeNode).join('\n')
}

function serializeNode(node: Descendant): string {
  if ('text' in node) {
    return node.text
  }

  switch (node.type) {
    case 'emoji':
      return node.unicode

    case 'custom-emoji':
      return node.token

    case 'user-mention':
      return `<@${node.userId}>`

    case 'channel-mention':
      return `<#${node.channelId}>`

    case 'blockquote':
      return node.children
        .map((child) => `> ${serializeNode(child)}`)
        .join('\n')

    case 'code-block':
      return (
        '```' +
        node.language +
        '\n' +
        node.children.map(serializeNode).join('\n') +
        '\n```'
      )

    case 'code-block-line':
    case 'line':
      return node.children.map(serializeNode).join('')

    default:
      return Node.string(node)
  }
}
