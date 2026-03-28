import type { BaseEditor, Descendant } from 'slate'
import type { ReactEditor } from 'slate-react'
import type { HistoryEditor } from 'slate-history'

// --- Block elements ---

export type LineElement = {
  type: 'line'
  children: Descendant[]
}

export type BlockQuoteElement = {
  type: 'blockquote'
  children: Descendant[]
}

export type CodeBlockElement = {
  type: 'code-block'
  language: string
  children: CodeBlockLineElement[]
}

export type CodeBlockLineElement = {
  type: 'code-block-line'
  children: CustomText[]
}

// --- Inline void elements ---

export type EmojiElement = {
  type: 'emoji'
  unicode: string
  children: [EmptyText]
}

export type CustomEmojiElement = {
  type: 'custom-emoji'
  token: string
  name: string
  url: string
  animated: boolean
  children: [EmptyText]
}

export type UserMentionElement = {
  type: 'user-mention'
  userId: string
  displayName: string
  children: [EmptyText]
}

export type ChannelMentionElement = {
  type: 'channel-mention'
  channelId: string
  channelName: string
  children: [EmptyText]
}

// --- Union types ---

export type CustomElement =
  | LineElement
  | BlockQuoteElement
  | CodeBlockElement
  | CodeBlockLineElement
  | EmojiElement
  | CustomEmojiElement
  | UserMentionElement
  | ChannelMentionElement

export type EmptyText = { text: '' }

export type CustomText = {
  text: string
  // Leaf decorations (applied by decorate, not stored)
  bold?: true
  italic?: true
  underline?: true
  strikethrough?: true
  inlineCode?: true
  spoiler?: true
  link?: string
  syntaxMark?: true
  codeBlockText?: true
}

// --- Slate module augmentation ---

declare module 'slate' {
  interface CustomTypes {
    Editor: BaseEditor & ReactEditor & HistoryEditor
    Element: CustomElement
    Text: CustomText
  }
}

// --- Helpers ---

export const VOID_TYPES = new Set([
  'emoji',
  'custom-emoji',
  'user-mention',
  'channel-mention',
])

export const INLINE_TYPES = new Set([
  'emoji',
  'custom-emoji',
  'user-mention',
  'channel-mention',
])

export function emptyDocument(): Descendant[] {
  return [{ type: 'line', children: [{ text: '' }] }]
}
