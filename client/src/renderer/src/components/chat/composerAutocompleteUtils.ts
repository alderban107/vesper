import type { Channel, Member, Server } from '../../stores/serverStore'
import type { DmConversation } from '../../stores/dmStore'
import type { ComposerAutocompleteItem } from './ComposerAutocomplete'
import { EMOJIS } from '../../data/emojis'
import { formatCustomEmojiToken } from '../../utils/emoji'

export interface ComposerTriggerMatch {
  type: 'mention' | 'channel' | 'emoji'
  query: string
  start: number
}

export function detectComposerTrigger(
  value: string,
  cursorPos: number
): ComposerTriggerMatch | null {
  const textBeforeCursor = value.slice(0, cursorPos)
  const match = textBeforeCursor.match(/(^|\s)([@#:])([^\s@#:<>]*)$/)

  if (!match) {
    return null
  }

  const symbol = match[2]
  const query = match[3] ?? ''
  const start = cursorPos - query.length - 1

  if (symbol === '@') {
    return { type: 'mention', query, start }
  }

  if (symbol === '#') {
    return { type: 'channel', query, start }
  }

  return { type: 'emoji', query, start }
}

export function buildMentionSuggestions(
  query: string,
  members: Member[],
  conversation?: DmConversation | null
): ComposerAutocompleteItem[] {
  const normalized = query.toLowerCase()
  const items: ComposerAutocompleteItem[] = []

  if ('everyone'.startsWith(normalized) || normalized === '') {
    items.push({
      id: 'everyone',
      label: '@everyone',
      sublabel: 'Notify all members',
      value: '<@everyone>',
      type: 'everyone'
    })
  }

  const seen = new Set<string>()
  for (const member of members) {
    if (seen.has(member.user_id)) {
      continue
    }
    seen.add(member.user_id)

    const displayName = member.user?.display_name || member.user?.username || ''
    const username = member.user?.username || ''
    if (
      normalized &&
      !displayName.toLowerCase().includes(normalized) &&
      !username.toLowerCase().includes(normalized)
    ) {
      continue
    }

    items.push({
      id: member.user_id,
      label: displayName || username,
      sublabel: username && displayName !== username ? `@${username}` : undefined,
      value: `<@${member.user_id}>`,
      type: 'user'
    })
  }

  if (conversation) {
    for (const participant of conversation.participants) {
      if (seen.has(participant.user_id)) {
        continue
      }

      const displayName = participant.user.display_name || participant.user.username
      const username = participant.user.username
      if (
        normalized &&
        !displayName.toLowerCase().includes(normalized) &&
        !username.toLowerCase().includes(normalized)
      ) {
        continue
      }

      seen.add(participant.user_id)
      items.push({
        id: participant.user_id,
        label: displayName,
        sublabel: username && displayName !== username ? `@${username}` : undefined,
        value: `<@${participant.user_id}>`,
        type: 'user'
      })
    }
  }

  return items.slice(0, 8)
}

export function buildChannelSuggestions(
  query: string,
  server?: Server | null
): ComposerAutocompleteItem[] {
  const normalized = query.toLowerCase()
  const channels = (server?.channels ?? []).filter((channel) => channel.type !== 'category')

  return channels
    .filter((channel) => normalized === '' || channel.name.toLowerCase().includes(normalized))
    .slice(0, 8)
    .map((channel: Channel) => ({
      id: channel.id,
      label: `#${channel.name}`,
      sublabel: channel.topic || undefined,
      value: `<#${channel.id}>`,
      type: 'channel'
    }))
}

export function buildEmojiSuggestions(
  query: string,
  server?: Server | null
): ComposerAutocompleteItem[] {
  const normalized = query.toLowerCase()
  const native = EMOJIS
    .filter((emoji) =>
      normalized === '' ||
      emoji.name.toLowerCase().includes(normalized) ||
      emoji.keywords.some((keyword) => keyword.toLowerCase().includes(normalized))
    )
    .slice(0, 6)
    .map((emoji) => ({
      id: `unicode:${emoji.name}`,
      label: `:${emoji.name}:`,
      sublabel: emoji.keywords.slice(0, 3).join(' • ') || undefined,
      value: emoji.emoji,
      type: 'emoji' as const,
      emojiGlyph: emoji.emoji
    }))

  const custom = (server?.emojis ?? [])
    .filter((emoji) => normalized === '' || emoji.name.toLowerCase().includes(normalized))
    .slice(0, 6)
    .map((emoji) => ({
      id: `custom:${emoji.id}`,
      label: `:${emoji.name}:`,
      sublabel: 'Custom emoji',
      value: formatCustomEmojiToken(emoji),
      type: 'emoji' as const,
      emojiGlyph: ':'
    }))

  return [...custom, ...native].slice(0, 8)
}

export function applyAutocompleteSelection(
  currentValue: string,
  triggerStart: number,
  cursorPos: number,
  replacement: string,
  trailingSpace = true
): {
  value: string
  caret: number
} {
  const before = currentValue.slice(0, triggerStart)
  const after = currentValue.slice(cursorPos)
  const inserted = trailingSpace ? `${replacement} ` : replacement
  const value = `${before}${inserted}${after}`

  return {
    value,
    caret: before.length + inserted.length
  }
}
