export interface CustomEmoji {
  id: string
  name: string
  url: string
  animated?: boolean
  server_id?: string
}

export interface ParsedEmojiToken {
  id: string
  name: string
  animated: boolean
}

const CUSTOM_EMOJI_REGEX = /<(?<animated>a?):(?<name>[a-zA-Z0-9_~-]{2,32}):(?<id>[a-zA-Z0-9_-]+)>/

export function parseCustomEmojiToken(value: string): ParsedEmojiToken | null {
  const match = value.match(CUSTOM_EMOJI_REGEX)
  if (!match?.groups) {
    return null
  }

  return {
    id: match.groups.id,
    name: match.groups.name,
    animated: match.groups.animated === 'a'
  }
}

export function formatCustomEmojiToken(emoji: CustomEmoji): string {
  return `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`
}

export function findCustomEmoji(value: string, emojis: CustomEmoji[]): CustomEmoji | null {
  const parsed = parseCustomEmojiToken(value)
  if (!parsed) {
    return null
  }

  return emojis.find((emoji) => emoji.id === parsed.id || emoji.name === parsed.name) ?? null
}

/**
 * Replace :name: shortcodes with full <:name:id> tokens before sending.
 * Only matches standalone shortcodes — skips those already inside full tokens.
 */
export function replaceEmojiShortcodes(text: string, emojis: CustomEmoji[]): string {
  if (emojis.length === 0) return text

  // Match :name: but not when preceded by < or <a (already a full token)
  return text.replace(/(?<!<a?):([\w~-]{2,32}):/g, (match, name: string) => {
    const emoji = emojis.find((e) => e.name === name)
    if (!emoji) return match
    return formatCustomEmojiToken(emoji)
  })
}
