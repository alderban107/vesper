import { useState } from 'react'
import rehypeKatex from 'rehype-katex'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import type { Components } from 'react-markdown'
import { useServerStore } from '../../stores/serverStore'
import { useDmStore } from '../../stores/dmStore'
import { useAuthStore } from '../../stores/authStore'
import { usePresenceStore } from '../../stores/presenceStore'
import { findCustomEmoji, parseCustomEmojiToken, type CustomEmoji } from '../../utils/emoji'
import { emojiToCodepoints } from '../../utils/twemoji'
import ProfilePopout from '../profile/ProfilePopout'
import { extractMarkdownCodeBlock } from './MarkdownCodeBlock'
import MermaidBlock from './MermaidBlock'
import EmojiGlyph from './message/EmojiGlyph'
import SpoilerReveal from './message/SpoilerReveal'

interface Props {
  content: string
}

interface MentionUserEntry {
  id: string
  username?: string
  display_name?: string | null
}

// Pre-process mention syntax into markdown links
function preprocessMentions(
  text: string,
  users: MentionUserEntry[]
): string {
  // Replace <@userId> with styled link
  let result = text.replace(/<@([0-9a-f-]{36})>/g, (_match, userId: string) => {
    const user = users.find((entry) => entry.id === userId)
    const name = user?.display_name || user?.username || 'Unknown'
    return `[@${name}](mention:${userId})`
  })

  // Replace <@everyone>
  result = result.replace(/<@everyone>/g, '[@everyone](mention:everyone)')

  return result
}

function preprocessChannels(text: string, channels: Array<{ id: string; name: string }>): string {
  return text.replace(/<#([0-9a-f-]{36})>/g, (_match, channelId: string) => {
    const channel = channels.find((entry) => entry.id === channelId)
    const name = channel?.name || 'unknown-channel'
    return `[#${name}](channel:${channelId})`
  })
}

function preprocessCustomEmoji(text: string, customEmojis: CustomEmoji[]): string {
  return text.replace(/<(a?):([a-zA-Z0-9_~-]{2,32}):([a-zA-Z0-9_-]+)>/g, (match) => {
    const customEmoji = findCustomEmoji(match, customEmojis)
    if (!customEmoji) {
      const parsed = parseCustomEmojiToken(match)
      return parsed ? `:${parsed.name}:` : match
    }

    const encoded = encodeURIComponent(match)
    return `![${customEmoji.name}](emoji:${encoded})`
  })
}

// Match Unicode emoji: presentation emoji, extended pictographic with optional FE0F/ZWJ sequences
const UNICODE_EMOJI_RE = /(\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F?)(\u200D(\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F?))*/gu

function preprocessUnicodeEmoji(text: string): string {
  return text.replace(UNICODE_EMOJI_RE, (match) => {
    const codepoints = emojiToCodepoints(match)
    return `![${match}](twemoji:${codepoints})`
  })
}

function preprocessSpoilers(text: string): string {
  // Convert ||spoiler text|| to a link with spoiler: protocol
  // This preserves the content through react-markdown and lets us
  // render it with the SpoilerReveal component.
  return text.replace(/\|\|(.+?)\|\|/g, (_match, content: string) => {
    const encoded = encodeURIComponent(content)
    return `[${content}](spoiler:${encoded})`
  })
}

export default function MarkdownContent({ content }: Props): React.JSX.Element {
  const members = useServerStore((s) => s.members)
  const activeServer = useServerStore((s) => s.servers.find((server) => server.id === s.activeServerId))
  const setActiveChannel = useServerStore((s) => s.setActiveChannel)
  const selectConversation = useDmStore((s) => s.selectConversation)
  const selectedConversationId = useDmStore((s) => s.selectedConversationId)
  const conversations = useDmStore((s) => s.conversations)
  const currentUser = useAuthStore((s) => s.user)
  const getStatus = usePresenceStore((s) => s.getStatus)
  const customEmojis = activeServer?.emojis ?? []
  const activeConversation = conversations.find((conversation) => conversation.id === selectedConversationId)
  const [mentionAnchor, setMentionAnchor] = useState<DOMRect | null>(null)
  const [mentionUserId, setMentionUserId] = useState<string | null>(null)
  const channels = selectedConversationId
    ? []
    : (activeServer?.channels ?? []).filter((channel) => channel.type !== 'category')
  const mentionUsers: MentionUserEntry[] = []

  if (currentUser) {
    mentionUsers.push({
      id: currentUser.id,
      username: currentUser.username,
      display_name: currentUser.display_name
    })
  }

  for (const member of members) {
    if (!member.user) {
      continue
    }

    mentionUsers.push({
      id: member.user_id,
      username: member.user.username,
      display_name: member.user.display_name
    })
  }

  for (const participant of activeConversation?.participants ?? []) {
    mentionUsers.push({
      id: participant.user_id,
      username: participant.user.username,
      display_name: participant.user.display_name
    })
  }

  const dedupedMentionUsers = mentionUsers.filter(
    (entry, index, collection) =>
      collection.findIndex((candidate) => candidate.id === entry.id) === index
  )
  const processed = preprocessSpoilers(
    preprocessUnicodeEmoji(
      preprocessCustomEmoji(
        preprocessChannels(preprocessMentions(content, dedupedMentionUsers), channels),
        customEmojis
      )
    )
  )
  const mentionedUser = (() => {
    if (!mentionUserId) {
      return null
    }

    if (currentUser?.id === mentionUserId) {
      return {
        id: currentUser.id,
        username: currentUser.username,
        displayName: currentUser.display_name || currentUser.username,
        avatarUrl: currentUser.avatar_url,
        bannerUrl: currentUser.banner_url,
        status: getStatus(currentUser.id),
        isCurrentUser: true
      }
    }

    const member = members.find((entry) => entry.user_id === mentionUserId)
    if (member?.user) {
      return {
        id: member.user.id,
        username: member.user.username,
        displayName: member.user.display_name || member.user.username,
        avatarUrl: member.user.avatar_url,
        status: getStatus(member.user_id),
        nickname: member.nickname,
        roleLabel: member.role,
        isCurrentUser: false
      }
    }

    const participant = activeConversation?.participants.find((entry) => entry.user_id === mentionUserId)
    if (participant?.user) {
      return {
        id: participant.user.id,
        username: participant.user.username,
        displayName: participant.user.display_name || participant.user.username,
        avatarUrl: participant.user.avatar_url,
        status: getStatus(participant.user.id),
        isCurrentUser: false
      }
    }

    return null
  })()
  const components: Components = {
    p: ({ children }) => {
      const childArray = Array.isArray(children) ? children : [children]
      const isEmojiOnly = childArray.length > 0 && childArray.length <= 10 &&
        childArray.every((child) =>
          (typeof child === 'object' && child !== null && 'props' in child &&
           typeof (child as { props?: { src?: string } }).props?.src === 'string' &&
           ((child as { props: { src: string } }).props.src.startsWith('twemoji:') ||
            (child as { props: { src: string } }).props.src.startsWith('/twemoji/'))) ||
          (typeof child === 'string' && child.trim() === '')
        )
      return (
        <p className={`vesper-markdown-paragraph${isEmojiOnly ? ' vesper-markdown-emoji-only' : ''}`}>{children}</p>
      )
    },
    strong: ({ children }) => <strong className="vesper-markdown-strong">{children}</strong>,
    em: ({ children }) => <em className="vesper-markdown-emphasis">{children}</em>,
    del: ({ children }) => <del className="vesper-markdown-strike">{children}</del>,
    code: ({ inline, className, children }) => {
      if (!inline) {
        return <code className={className}>{children}</code>
      }

      return (
        <code className="vesper-markdown-inline-code">
          {children}
        </code>
      )
    },
    pre: ({ children }) => {
      const codeBlock = extractMarkdownCodeBlock(children)
      if (!codeBlock) {
        return <pre className="vesper-markdown-pre">{children}</pre>
      }

      if (codeBlock.language?.toLowerCase() === 'mermaid') {
        return <MermaidBlock code={codeBlock.code} />
      }

      return (
        <div className="vesper-markdown-code-container">
          {codeBlock.language && (
            <span className="vesper-markdown-code-lang">{codeBlock.language}</span>
          )}
          <pre className="vesper-markdown-pre">
            <code className="vesper-markdown-code-block">{codeBlock.code}</code>
          </pre>
        </div>
      )
    },
    blockquote: ({ children }) => (
      <blockquote className="vesper-markdown-blockquote">
        {children}
      </blockquote>
    ),
    a: ({ href, children }) => {
      if (href?.startsWith('mention:')) {
        const mentionId = href.slice('mention:'.length)
        const isEveryone = mentionId === 'everyone'
        return (
          <button
            type="button"
            className={isEveryone ? 'vesper-inline-mention vesper-mention-highlight vesper-inline-mention-everyone' : 'vesper-inline-mention vesper-mention-highlight'}
            onClick={(event) => {
              if (isEveryone) {
                return
              }
              setMentionUserId(mentionId)
              setMentionAnchor((event.currentTarget as HTMLElement).getBoundingClientRect())
            }}
          >
            {children}
          </button>
        )
      }

      if (href?.startsWith('channel:')) {
        const channelId = href.slice('channel:'.length)
        return (
          <button
            type="button"
            className="vesper-inline-mention vesper-mention-highlight vesper-inline-channel-mention"
            onClick={() => {
              selectConversation(null)
              setActiveChannel(channelId)
            }}
          >
            {children}
          </button>
        )
      }

      if (href?.startsWith('spoiler:')) {
        return <SpoilerReveal>{children}</SpoilerReveal>
      }

      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-text underline"
        >
          {children}
        </a>
      )
    },
    img: ({ src, alt }) => {
      if (src?.startsWith('twemoji:')) {
        const codepoints = src.slice('twemoji:'.length)
        return (
          <img
            src={`/twemoji/${codepoints}.svg`}
            alt={alt || ''}
            draggable={false}
            className="vesper-twemoji-inline"
            loading="lazy"
            onError={(e) => {
              const span = document.createElement('span')
              span.textContent = alt || ''
              ;(e.target as HTMLElement).replaceWith(span)
            }}
          />
        )
      }

      if (src?.startsWith('emoji:')) {
        const token = decodeURIComponent(src.slice('emoji:'.length))
        const customEmoji = findCustomEmoji(token, customEmojis)

        if (!customEmoji) {
          return <span className="text-text-muted">{alt ? `:${alt}:` : token}</span>
        }

        return (
          <EmojiGlyph
            value={token}
            customEmojis={customEmojis}
            className="vesper-inline-custom-emoji"
            title={alt || customEmoji.name}
          />
        )
      }

      return <img src={src || ''} alt={alt || ''} />
    },
    ul: ({ children }) => <ul className="vesper-markdown-list">{children}</ul>,
    ol: ({ children }) => <ol className="vesper-markdown-list vesper-markdown-list-ordered">{children}</ol>,
    li: ({ children }) => <li className="vesper-markdown-list-item">{children}</li>
  }

  return (
    <>
      <div className="vesper-markdown">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
          urlTransform={(url) => url.startsWith('emoji:') || url.startsWith('twemoji:') ? url : defaultUrlTransform(url)}
          components={components}
        >
          {processed}
        </ReactMarkdown>
      </div>
      {mentionedUser && mentionAnchor && (
        <ProfilePopout
          user={mentionedUser}
          anchorRect={mentionAnchor}
          placement="top-right"
          onClose={() => {
            setMentionUserId(null)
            setMentionAnchor(null)
          }}
        />
      )}
    </>
  )
}
