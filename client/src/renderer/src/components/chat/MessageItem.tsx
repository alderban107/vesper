import { useState, useRef, useEffect } from 'react'
import { CornerDownRight, Reply, SmilePlus, Pencil, Trash2, Copy, Pin } from 'lucide-react'
import type { Message } from '../../stores/messageStore'
import { useMessageStore, parseMessageContent } from '../../stores/messageStore'
import { useAuthStore } from '../../stores/authStore'
import { usePresenceStore, type PresenceStatus } from '../../stores/presenceStore'
import { useServerStore } from '../../stores/serverStore'
import { useDmStore } from '../../stores/dmStore'
import Avatar from '../ui/Avatar'
import MarkdownContent from './MarkdownContent'
import EmojiPicker from './EmojiPicker'
import LinkPreview from './LinkPreview'
import FilePreview from './FilePreview'
import ContextMenu, { type ContextMenuItem } from '../ui/ContextMenu'
import { useContextMenu } from '../../hooks/useContextMenu'

const STATUS_COLORS: Record<PresenceStatus, string> = {
  online: 'bg-emerald-500',
  idle: 'bg-amber-500',
  dnd: 'bg-red-500',
  offline: 'bg-gray-500'
}

interface Props {
  message: Message
  messages?: Message[]
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

export default function MessageItem({ message, messages }: Props): React.JSX.Element {
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [editText, setEditText] = useState('')
  const editRef = useRef<HTMLTextAreaElement>(null)
  const members = useServerStore((s) => s.members)
  const myUser = useAuthStore((s) => s.user)
  const myId = myUser?.id
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

  const activeChannelId = useServerStore((s) => s.activeChannelId)
  const selectedConversationId = useDmStore((s) => s.selectedConversationId)

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

  return (
    <div
      className="flex gap-3 py-1.5 hover:bg-bg-secondary/30 rounded-lg px-2 -mx-2 group transition-colors"
      onContextMenu={(e) => msgMenu.onContextMenu(e, message)}
    >
      <div className="relative w-10 h-10 shrink-0 mt-0.5">
        <Avatar
          userId={message.sender_id || 'unknown'}
          avatarUrl={avatarUrl}
          displayName={displayName}
          size="md"
        />
        <div className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-bg-primary ${STATUS_COLORS[status]}`} />
      </div>

      <div className="min-w-0 flex-1">
        {/* Reply context */}
        {parentMessage && (
          <div className="flex items-center gap-1.5 text-xs text-text-faint mb-0.5 pl-0.5">
            <CornerDownRight className="w-3 h-3 text-text-disabled" />
            <span className="font-medium text-text-muted">
              {(() => {
                if (parentMessage.sender_id === myId) return myUser?.display_name || myUser?.username || 'Unknown'
                const pm = members.find((m) => m.user_id === parentMessage.sender_id)
                return pm?.user?.display_name || pm?.user?.username || parentMessage.sender?.display_name || parentMessage.sender?.username || 'Unknown'
              })()}
            </span>
            <span className="truncate max-w-[200px]">
              {parentMessage.content?.slice(0, 60)}
              {(parentMessage.content?.length || 0) > 60 ? '...' : ''}
            </span>
          </div>
        )}

        <div className="flex items-baseline gap-2">
          <span className="text-text-primary font-medium text-sm">{displayName}</span>
          <span className="text-text-faintest text-xs">{formatTime(message.inserted_at)}</span>

          {/* Hover toolbar — floating glass pill */}
          <div className="opacity-0 group-hover:opacity-100 transition-opacity ml-auto flex items-center gap-0.5 glass-card rounded-lg px-1 py-0.5">
            <button
              onClick={() => setReplyingTo(message)}
              className="text-text-faint hover:text-text-primary p-1 rounded hover:bg-bg-tertiary/50 transition-colors"
              title="Reply"
            >
              <Reply className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setShowEmojiPicker(!showEmojiPicker)}
              className="text-text-faint hover:text-text-primary p-1 rounded hover:bg-bg-tertiary/50 transition-colors"
              title="React"
            >
              <SmilePlus className="w-3.5 h-3.5" />
            </button>
            {isMe && (
              <>
                <button
                  onClick={handleStartEdit}
                  className="text-text-faint hover:text-text-primary p-1 rounded hover:bg-bg-tertiary/50 transition-colors"
                  title="Edit"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={handleDelete}
                  className="text-text-faint hover:text-red-400 p-1 rounded hover:bg-bg-tertiary/50 transition-colors"
                  title="Delete"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        </div>

        {isEditing ? (
          <div className="mt-0.5">
            <textarea
              ref={editRef}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={handleEditKeyDown}
              className="w-full bg-bg-tertiary/50 text-text-secondary text-sm rounded-lg px-3 py-2 border border-border focus:border-accent/50 focus:outline-none resize-none"
              rows={Math.min(editText.split('\n').length + 1, 6)}
            />
            <p className="text-text-faintest text-xs mt-0.5">
              Enter to save · Escape to cancel
            </p>
          </div>
        ) : (
          <>
            {/* Text content (or caption for file messages) */}
            {displayText && (
              <div className="text-text-secondary text-sm break-words whitespace-pre-wrap">
                <MarkdownContent content={displayText} />
                {message.edited_at && (
                  <span className="text-text-faintest text-xs ml-1.5">(edited)</span>
                )}
              </div>
            )}

            {/* File preview for file messages */}
            {parsed.type === 'file' && (
              <FilePreview file={parsed.file} />
            )}

            {/* Link previews (only for text messages) */}
            {parsed.type === 'text' && extractUrls(parsed.text).map((url) => (
              <LinkPreview key={url} url={url} />
            ))}

            {/* Edited indicator when no text displayed yet */}
            {!displayText && message.edited_at && (
              <span className="text-text-faintest text-xs">(edited)</span>
            )}
          </>
        )}

        {/* Reactions */}
        {message.reactions && message.reactions.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {message.reactions.map((r) => {
              const isMine = myId ? r.senderIds.includes(myId) : false
              return (
                <button
                  key={r.emoji}
                  onClick={() => handleReaction(r.emoji)}
                  className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs transition-all ${
                    isMine
                      ? 'border border-accent/50 bg-accent/10 text-accent-text shadow-[0_0_8px_rgba(200,162,78,0.15)]'
                      : 'border border-border bg-bg-tertiary/50 text-text-muted hover:border-text-faint'
                  }`}
                >
                  <span>{r.emoji}</span>
                  <span>{r.senderIds.length}</span>
                </button>
              )
            })}
          </div>
        )}

        {/* Emoji picker for reactions */}
        {showEmojiPicker && (
          <div className="mt-1.5">
            <EmojiPicker
              onSelect={(emoji) => handleReaction(emoji)}
              onClose={() => setShowEmojiPicker(false)}
            />
          </div>
        )}
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
