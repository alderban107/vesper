import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import { useServerStore } from '../../stores/serverStore'
import { useDmStore } from '../../stores/dmStore'
import { useAuthStore } from '../../stores/authStore'
import { usePresenceStore } from '../../stores/presenceStore'
import { findCustomEmoji, parseCustomEmojiToken, type CustomEmoji } from '../../utils/emoji'
import ProfilePopout from '../profile/ProfilePopout'
import EmojiGlyph from './message/EmojiGlyph'

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
  const processed = preprocessCustomEmoji(
    preprocessChannels(preprocessMentions(content, dedupedMentionUsers), channels),
    customEmojis
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
    p: ({ children }) => (
      <p className="text-text-secondary text-sm break-words whitespace-pre-wrap">{children}</p>
    ),
    strong: ({ children }) => <strong className="font-semibold text-text-primary">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    del: ({ children }) => <del className="line-through text-text-muted">{children}</del>,
    code: ({ className, children }) => {
      if (className) {
        return <code className={className}>{children}</code>
      }

      return (
        <code className="bg-bg-tertiary rounded px-1.5 py-0.5 font-mono text-xs text-accent-text">
          {children}
        </code>
      )
    },
    pre: ({ children }) => (
      <pre className="bg-bg-base rounded-lg border border-border overflow-x-auto p-3 my-1 text-sm">
        {children}
      </pre>
    ),
    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-accent/50 pl-3 text-text-muted italic my-1">
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
    ul: ({ children }) => <ul className="list-disc list-inside my-0.5">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal list-inside my-0.5">{children}</ol>,
    li: ({ children }) => <li className="text-text-secondary text-sm">{children}</li>
  }

  return (
    <>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {processed}
      </ReactMarkdown>
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
