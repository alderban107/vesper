import { useState, useRef, useEffect } from 'react'
import { Copy, Pencil, Pin, Reply, Trash2 } from 'lucide-react'
import type { Message } from '../../stores/messageStore'
import { useMessageStore, parseMessageContent } from '../../stores/messageStore'
import { useAuthStore } from '../../stores/authStore'
import { usePresenceStore, type PresenceStatus } from '../../stores/presenceStore'
import { useServerStore } from '../../stores/serverStore'
import Avatar from '../ui/Avatar'
import MarkdownContent from './MarkdownContent'
import EmojiPicker from './EmojiPicker'
import LinkPreview from './LinkPreview'
import FilePreview from './FilePreview'
import ContextMenu, { type ContextMenuItem } from '../ui/ContextMenu'
import { useContextMenu } from '../../hooks/useContextMenu'
import MessageActions from './message/MessageActions'
import MessageReplyPreview from './message/MessageReplyPreview'
import MessageReactionBar from './message/MessageReactionBar'
import { formatCustomEmojiToken, type CustomEmoji } from '../../utils/emoji'

const STATUS_COLORS: Record<PresenceStatus, string> = {
  online: 'bg-emerald-500',
  idle: 'bg-amber-500',
  dnd: 'bg-red-500',
  offline: 'bg-gray-500'
}

interface Props {
  message: Message
  messages?: Message[]
  previousMessage?: Message | null
}

function formatTime(isoString: string): string {
  const date = new Date(isoString)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()

  if (isToday) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

const URL_REGEX = /https?:\/\/[^\s<>)"']+/g

function extractUrls(text: string): string[] {
  const matches = text.match(URL_REGEX)
  if (!matches) return []
  // Dedupe and limit to 3
  return [...new Set(matches)].slice(0, 3)
}

function getMessageGroupState(message: Message, previousMessage?: Message | null): boolean {
  if (!previousMessage) {
    return true
  }

  if (message.sender_id !== previousMessage.sender_id) {
    return true
  }

  if (new Date(message.inserted_at).toDateString() !== new Date(previousMessage.inserted_at).toDateString()) {
    return true
  }

  if (message.parent_message_id) {
    return true
  }

  if (previousMessage.parent_message_id) {
    return true
  }

  const currentTime = new Date(message.inserted_at).getTime()
  const previousTime = new Date(previousMessage.inserted_at).getTime()

  return currentTime - previousTime > 5 * 60 * 1000
}

function formatExpiryLabel(expiresAt: string, nowMs: number): string {
  const remainingMs = Math.max(0, new Date(expiresAt).getTime() - nowMs)
  const totalSeconds = Math.ceil(remainingMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}h ${minutes}m left`
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s left`
  }

  return `${seconds}s left`
}

function formatExpiryTooltip(expiresAt: string, nowMs: number): string {
  const remainingLabel = formatExpiryLabel(expiresAt, nowMs)
  const expiresLabel = new Date(expiresAt).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })

  return `Disappears in ${remainingLabel} (${expiresLabel})`
}

function getExpiryRefreshDelay(expiresAt: string, nowMs: number): number {
  const remainingMs = Math.max(0, new Date(expiresAt).getTime() - nowMs)

  if (remainingMs > 60 * 60 * 1000) {
    return 60 * 1000
  }

  if (remainingMs > 60 * 1000) {
    return 10 * 1000
  }

  return 1000
}

function useExpiryLabel(expiresAt: string | null): string | null {
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (!expiresAt) {
      return
    }

    const tick = (): void => {
      setNowMs(Date.now())
    }

    tick()
    const timeoutId = window.setTimeout(tick, getExpiryRefreshDelay(expiresAt, Date.now()))

    return () => window.clearTimeout(timeoutId)
  }, [expiresAt, nowMs])

  if (!expiresAt) {
    return null
  }

  return formatExpiryTooltip(expiresAt, nowMs)
}

export default function MessageItem({ message, messages, previousMessage }: Props): React.JSX.Element {
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [editText, setEditText] = useState('')
  const editRef = useRef<HTMLTextAreaElement>(null)
  const members = useServerStore((s) => s.members)
  const myUser = useAuthStore((s) => s.user)
  const myId = myUser?.id
  const activeServer = useServerStore((s) => s.servers.find((server) => server.id === s.activeServerId))
  const customEmojis: CustomEmoji[] = activeServer?.emojis ?? []
  const isMe = message.sender_id === myId
  const liveMember = members.find((m) => m.user_id === message.sender_id)
  const displayName = isMe
    ? (myUser?.display_name || myUser?.username || 'Unknown')
    : (liveMember?.user?.display_name || liveMember?.user?.username || message.sender?.display_name || message.sender?.username || 'Unknown')
  const avatarUrl = isMe
    ? myUser?.avatar_url
    : (liveMember?.user?.avatar_url || message.sender?.avatar_url)
  const status = usePresenceStore((s) => s.getStatus(message.sender_id || ''))
  const setReplyingTo = useMessageStore((s) => s.setReplyingTo)
  const addReaction = useMessageStore((s) => s.addReaction)
  const removeReaction = useMessageStore((s) => s.removeReaction)
  const pinMessage = useMessageStore((s) => s.pinMessage)
  const editingMessage = useMessageStore((s) => s.editingMessage)
  const setEditingMessage = useMessageStore((s) => s.setEditingMessage)
  const editMessage = useMessageStore((s) => s.editMessage)
  const deleteMessage = useMessageStore((s) => s.deleteMessage)

  const targetId = message.channel_id || message.conversation_id || ''
  const topic = message.channel_id
    ? `chat:channel:${message.channel_id}`
    : `dm:${message.conversation_id}`

  const isEditing = editingMessage?.id === message.id

  const msgMenu = useContextMenu<Message>()

  // Parse content for file messages
  const parsed = parseMessageContent(message.content)

  useEffect(() => {
    if (isEditing && editRef.current) {
      editRef.current.focus()
      editRef.current.selectionStart = editRef.current.value.length
    }
  }, [isEditing])

  const handleStartEdit = (): void => {
    setEditText(message.content)
    setEditingMessage(message)
  }

  const handleSaveEdit = (): void => {
    const trimmed = editText.trim()
    if (trimmed && trimmed !== message.content) {
      editMessage(targetId, topic, message.id, trimmed)
    } else {
      setEditingMessage(null)
    }
  }

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSaveEdit()
    } else if (e.key === 'Escape') {
      setEditingMessage(null)
    }
  }

  const handleDelete = (): void => {
    deleteMessage(targetId, topic, message.id)
  }

  const parentMessage = message.parent_message_id && messages
    ? messages.find((m) => m.id === message.parent_message_id)
    : null

  const startsGroup = getMessageGroupState(message, previousMessage)
  const expiryLabel = useExpiryLabel(message.expires_at)

  const handleReaction = (emoji: string): void => {
    const existing = message.reactions?.find((r) => r.emoji === emoji)
    if (existing && myId && existing.senderIds.includes(myId)) {
      removeReaction(targetId, topic, message.id, emoji)
    } else {
      addReaction(targetId, topic, message.id, emoji)
    }
    setShowEmojiPicker(false)
  }

  const getMessageItems = (): ContextMenuItem[] => {
    return [
      {
        label: 'Reply',
        icon: Reply,
        onClick: () => setReplyingTo(message)
      },
      ...(isMe
        ? [
            {
              label: 'Edit',
              icon: Pencil,
              onClick: handleStartEdit
            },
            {
              label: 'Delete',
              icon: Trash2,
              onClick: handleDelete,
              danger: true
            }
          ]
        : []),
      {
        label: 'Copy Text',
        icon: Copy,
        onClick: () => navigator.clipboard.writeText(
          parsed.type === 'file' ? (parsed.text || parsed.file.name) : parsed.text
        ),
        divider: true
      },
      ...(message.channel_id
        ? [
            {
              label: 'Pin Message',
              icon: Pin,
              onClick: () => pinMessage(topic, message.id)
            }
          ]
        : []),
      {
        label: 'Copy Message ID',
        icon: Copy,
        onClick: () => navigator.clipboard.writeText(message.id)
      }
    ]
  }

  // Text content for display (caption for file messages, full text for text messages)
  const displayText = parsed.type === 'file' ? parsed.text : parsed.text
  const replyPreview = parentMessage?.content?.slice(0, 72) || 'View message'
  const replyAuthorName = (() => {
    if (!parentMessage) {
      return ''
    }

    if (parentMessage.sender_id === myId) {
      return myUser?.display_name || myUser?.username || 'Unknown'
    }

    const pm = members.find((m) => m.user_id === parentMessage.sender_id)
    return pm?.user?.display_name || pm?.user?.username || parentMessage.sender?.display_name || parentMessage.sender?.username || 'Unknown'
  })()

  return (
    <div
      className={
        startsGroup
          ? 'vesper-message-row vesper-message-row-start group'
          : 'vesper-message-row vesper-message-row-grouped group'
      }
      onContextMenu={(e) => msgMenu.onContextMenu(e, message)}
    >
      <div className="vesper-message-avatar-column">
        {startsGroup ? (
          <div className="relative w-10 h-10 shrink-0 mt-0.5">
            <Avatar
              userId={message.sender_id || 'unknown'}
              avatarUrl={avatarUrl}
              displayName={displayName}
              size="md"
            />
            <div className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-bg-primary ${STATUS_COLORS[status]}`} />
          </div>
        ) : (
          <span className="vesper-message-inline-time">{formatTime(message.inserted_at)}</span>
        )}
      </div>

      <div className="vesper-message-body">
        <div className="vesper-message-toolbar-slot">
          <div className="vesper-message-toolbar-anchor">
            <MessageActions
              canEdit={isMe}
              onReply={() => setReplyingTo(message)}
              onReact={() => setShowEmojiPicker((value) => !value)}
              onEdit={handleStartEdit}
              onDelete={handleDelete}
              expiryLabel={expiryLabel}
            />
            {showEmojiPicker && (
              <div className="vesper-message-emoji-popout">
                <EmojiPicker
                  onSelect={(emoji, item) => handleReaction(item?.type === 'custom' ? formatCustomEmojiToken(item) : emoji)}
                  onClose={() => setShowEmojiPicker(false)}
                />
              </div>
            )}
          </div>
        </div>

        {parentMessage && (
          <MessageReplyPreview
            authorName={replyAuthorName}
            preview={replyPreview + ((parentMessage.content?.length || 0) > 72 ? '...' : '')}
          />
        )}

        {startsGroup && (
          <div className="vesper-message-header">
            <span className="vesper-message-author">{displayName}</span>
            <span className="vesper-message-time">{formatTime(message.inserted_at)}</span>
          </div>
        )}

        {isEditing ? (
          <div className="mt-1">
            <textarea
              ref={editRef}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={handleEditKeyDown}
              className="w-full rounded-xl border border-border bg-bg-secondary/70 px-3 py-2 text-sm text-text-secondary focus:border-accent/50 focus:outline-none resize-none"
              rows={Math.min(editText.split('\n').length + 1, 6)}
            />
            <p className="mt-1 text-xs text-text-faintest">
              Enter to save · Escape to cancel
            </p>
          </div>
        ) : (
          <>
            {displayText && (
              <div className="vesper-message-content text-text-secondary text-sm break-words whitespace-pre-wrap">
                <MarkdownContent content={displayText} />
                {message.edited_at && (
                  <span className="ml-1.5 text-xs text-text-faintest">(edited)</span>
                )}
              </div>
            )}

            {parsed.type === 'file' && (
              <FilePreview file={parsed.file} />
            )}

            {parsed.type === 'text' && extractUrls(parsed.text).map((url) => (
              <LinkPreview key={url} url={url} />
            ))}

            {!displayText && message.edited_at && (
              <span className="text-text-faintest text-xs">(edited)</span>
            )}
          </>
        )}

        <MessageReactionBar
          reactions={message.reactions ?? []}
          currentUserId={myId ?? undefined}
          onToggleReaction={handleReaction}
          customEmojis={customEmojis}
        />
      </div>

      {msgMenu.menu && (
        <ContextMenu
          x={msgMenu.menu.x}
          y={msgMenu.menu.y}
          items={getMessageItems()}
          onClose={msgMenu.closeMenu}
        />
      )}
    </div>
  )
}
