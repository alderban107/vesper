import { memo, Suspense, useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Copy, Lock, MessageSquare, Pencil, Pin, Reply, Trash2 } from 'lucide-react'
import type { Message } from '../../stores/messageStore'
import { useMessageStore, parseMessageContent } from '../../stores/messageStore'
import { useAuthStore } from '../../stores/authStore'
import { usePresenceStore } from '../../stores/presenceStore'
import { useServerStore } from '../../stores/serverStore'
import { useDmStore } from '../../stores/dmStore'
import { useUIStore } from '../../stores/uiStore'
import Avatar from '../ui/Avatar'
import EmojiPicker from './EmojiPicker'
import LinkPreview from './LinkPreview'
import FilePreview from './FilePreview'
import ContextMenu, { type ContextMenuItem } from '../ui/ContextMenu'
import { useContextMenu } from '../../hooks/useContextMenu'
import MessageActions from './message/MessageActions'
import MessageReplyPreview from './message/MessageReplyPreview'
import MessageReactionBar from './message/MessageReactionBar'
import ProfilePopout from '../profile/ProfilePopout'
import { formatCustomEmojiToken, type CustomEmoji } from '../../utils/emoji'
import lazyWithRetry from '../../utils/lazyWithRetry'
import VesperEditor from './slate/VesperEditor'

const MarkdownContent = lazyWithRetry(() => import('./MarkdownContent'))
const EMPTY_EMOJIS: CustomEmoji[] = []

interface Props {
  message: Message
  messages?: Message[]
  previousMessage?: Message | null
  isThreadView?: boolean
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

function formatInlineTime(isoString: string): string {
  return new Date(isoString).toLocaleTimeString([], {
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

function getMessageGroupState(
  message: Message,
  previousMessage?: Message | null,
  isThreadView = false
): boolean {
  if (!previousMessage) {
    return true
  }

  if (message.sender_id !== previousMessage.sender_id) {
    return true
  }

  if (new Date(message.inserted_at).toDateString() !== new Date(previousMessage.inserted_at).toDateString()) {
    return true
  }

  if (!isThreadView && message.parent_message_id) {
    return true
  }

  if (!isThreadView && previousMessage.parent_message_id) {
    return true
  }

  const currentTime = new Date(message.inserted_at).getTime()
  const previousTime = new Date(previousMessage.inserted_at).getTime()

  return currentTime - previousTime > 30 * 60 * 1000
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

export default memo(function MessageItem({
  message,
  messages,
  previousMessage,
  isThreadView = false
}: Props): React.JSX.Element {
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const reactionAnchorRef = useRef<HTMLDivElement>(null)
  const membersByUserId = useServerStore((s) => s.membersByUserId)
  const liveMember = membersByUserId.get(message.sender_id ?? '')
  const myUser = useAuthStore((s) => s.user)
  const myId = myUser?.id
  const activeServer = useServerStore((s) =>
    s.servers.find((server) => server.id === s.activeServerId)
  )
  const customEmojis = activeServer?.emojis ?? EMPTY_EMOJIS
  const isMe = message.sender_id === myId
  const displayName = isMe
    ? (myUser?.display_name || myUser?.username || 'Unknown')
    : (liveMember?.user?.display_name || liveMember?.user?.username || message.sender?.display_name || message.sender?.username || 'Unknown')
  const avatarUrl = isMe
    ? myUser?.avatar_url
    : (liveMember?.user?.avatar_url || message.sender?.avatar_url)
  const status = usePresenceStore((s) => s.getStatus(message.sender_id || ''))
  const setReplyingTo = useMessageStore((s) => s.setReplyingTo)
  const openThread = useMessageStore((s) => s.openThread)
  const activeThreadParentId = useMessageStore((s) => s.activeThreadParentId)
  const focusedMessageId = useMessageStore((s) => s.focusedMessageId)
  const addReaction = useMessageStore((s) => s.addReaction)
  const removeReaction = useMessageStore((s) => s.removeReaction)
  const pinMessage = useMessageStore((s) => s.pinMessage)
  const editingMessage = useMessageStore((s) => s.editingMessage)
  const setEditingMessage = useMessageStore((s) => s.setEditingMessage)
  const editMessage = useMessageStore((s) => s.editMessage)
  const deleteMessage = useMessageStore((s) => s.deleteMessage)
  const createConversation = useDmStore((s) => s.createConversation)
  const setActiveServer = useServerStore((s) => s.setActiveServer)
  const openSettingsModal = useUIStore((s) => s.openSettingsModal)

  const [profileAnchor, setProfileAnchor] = useState<DOMRect | null>(null)
  const [showProfile, setShowProfile] = useState(false)

  const targetId = message.channel_id || message.conversation_id || ''
  const topic = message.channel_id
    ? `chat:channel:${message.channel_id}`
    : `dm:${message.conversation_id}`

  const isEditing = editingMessage?.id === message.id

  const msgMenu = useContextMenu<Message>()

  // Parse content for file messages
  const parsed = parseMessageContent(message.content)
  const urls = useMemo(
    () => parsed.type === 'text' ? extractUrls(parsed.text) : [],
    [message.content]
  )

  const handleStartEdit = (): void => {
    setEditingMessage(message)
  }

  const handleSaveEdit = useCallback((markdown: string): void => {
    const trimmed = markdown.trim()
    if (trimmed && trimmed !== message.content) {
      editMessage(targetId, topic, message.id, trimmed)
    } else {
      setEditingMessage(null)
    }
  }, [editMessage, message.content, message.id, setEditingMessage, targetId, topic])

  const handleDelete = (): void => {
    deleteMessage(targetId, topic, message.id)
  }

  const parentMessage = message.parent_message_id && messages
    ? messages.find((m) => m.id === message.parent_message_id)
    : null
  const threadAnchorMessage = message.parent_message_id ? (parentMessage ?? message) : message
  const threadAnchorId = threadAnchorMessage.id
  const fetchedThreadReplyCount = useMessageStore(
    (s) => s.threadRepliesByParent[threadAnchorId]?.length ?? 0
  )
  const inlineThreadReplyCount = messages
    ? messages.reduce((count, entry) => {
      return count + (entry.parent_message_id === threadAnchorId ? 1 : 0)
    }, 0)
    : 0
  const threadReplyCount = Math.max(fetchedThreadReplyCount, inlineThreadReplyCount)
  const isActiveThread = activeThreadParentId === threadAnchorId
  const threadActionLabel = message.parent_message_id ? 'Open thread' : 'Start thread'
  const showThreadSummary = !message.parent_message_id && threadReplyCount > 0
  const threadSummaryLabel = `${threadReplyCount} ${threadReplyCount === 1 ? 'reply' : 'replies'} in thread`
  const handleOpenThread = (): void => {
    void openThread(threadAnchorMessage)
  }

  const startsGroup = getMessageGroupState(message, previousMessage, isThreadView)
  const expiryLabel = useExpiryLabel(message.expires_at)
  const isFocusedMessage = focusedMessageId === message.id
  const isSending = message.delivery_state === 'sending'
  const isFailed = message.delivery_state === 'failed'

  useEffect(() => {
    if (!isFocusedMessage) {
      return
    }

    const node = document.querySelector<HTMLElement>(`[data-message-id="${message.id}"]`)
    node?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [isFocusedMessage, message.id])

  const handleReaction = (emoji: string): void => {
    const existing = message.reactions?.find((r) => r.emoji === emoji)
    if (existing && myId && existing.senderIds.includes(myId)) {
      removeReaction(targetId, topic, message.id, emoji)
    } else {
      addReaction(targetId, topic, message.id, emoji)
    }
    setShowEmojiPicker(false)
  }

  const handleOpenProfile = (event: React.MouseEvent): void => {
    setProfileAnchor((event.currentTarget as HTMLElement).getBoundingClientRect())
    setShowProfile(true)
  }

  const handleCloseProfile = (): void => {
    setShowProfile(false)
    setProfileAnchor(null)
  }

  const getMessageItems = (): ContextMenuItem[] => {
    return [
      {
        label: 'Reply',
        icon: Reply,
        onClick: () => setReplyingTo(message)
      },
      {
        label: 'Open Thread',
        icon: MessageSquare,
        onClick: handleOpenThread
      },
      ...(isMe
        ? [
            {
              label: 'Edit',
              icon: Pencil,
              onClick: handleStartEdit,
              testId: 'edit-message'
            },
            {
              label: 'Delete',
              icon: Trash2,
              onClick: handleDelete,
              danger: true,
              testId: 'delete-message'
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
              onClick: () => pinMessage(topic, message.id),
              testId: 'pin-message'
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

  const displayText = parsed.text
  const replyPreview = (() => {
    if (!parentMessage) {
      return 'View message'
    }

    const parentParsed = parseMessageContent(parentMessage.content || '')
    if (parentParsed.type === 'file') {
      return parentParsed.text || parentParsed.file.name || 'Sent a file'
    }

    return parentParsed.text || 'View message'
  })()
  const truncatedReplyPreview =
    replyPreview.length > 72 ? `${replyPreview.slice(0, 72)}...` : replyPreview
  const replyAuthorName = (() => {
    if (!parentMessage) {
      return ''
    }

    if (parentMessage.sender_id === myId) {
      return myUser?.display_name || myUser?.username || 'Unknown'
    }

    const pm = membersByUserId.get(parentMessage.sender_id ?? '')
    return pm?.user?.display_name || pm?.user?.username || parentMessage.sender?.display_name || parentMessage.sender?.username || 'Unknown'
  })()
  const isUnavailableMessage = displayText === 'Message unavailable - decryption failed'
  const unavailableLabel = startsGroup ? 'Encrypted message unavailable' : 'Message unavailable'

  return (
    <div
      data-testid="message-row"
      data-message-id={message.id}
      className={
        `${startsGroup
          ? 'vesper-message-row vesper-message-row-start group'
          : 'vesper-message-row vesper-message-row-grouped group'}${isActiveThread ? ' vesper-message-row-thread-active' : ''}${isFocusedMessage ? ' vesper-message-row-focused' : ''}${isSending ? ' vesper-message-row-sending' : ''}${isFailed ? ' vesper-message-row-failed' : ''}`
      }
      onContextMenu={(e) => msgMenu.onContextMenu(e, message)}
    >
      <div className="vesper-message-avatar-column">
        {startsGroup ? (
          <button
            type="button"
            className="relative w-10 h-10 shrink-0 mt-0.5 cursor-pointer border-0 bg-transparent p-0"
            onClick={handleOpenProfile}
          >
            <Avatar
              userId={message.sender_id || 'unknown'}
              avatarUrl={avatarUrl}
              displayName={displayName}
              size="md"
              status={status}
            />
          </button>
        ) : (
          <span className="vesper-message-inline-time">{formatInlineTime(message.inserted_at)}</span>
        )}
      </div>

      <div className="vesper-message-body">
        <div className="vesper-message-toolbar-slot">
          <div
            ref={reactionAnchorRef}
            className={
              showEmojiPicker
                ? 'vesper-message-toolbar-anchor vesper-message-toolbar-anchor-active'
                : 'vesper-message-toolbar-anchor'
            }
          >
            <MessageActions
              canEdit={isMe && !isUnavailableMessage}
              canInteract={!isUnavailableMessage}
              onReply={() => setReplyingTo(message)}
              onThread={handleOpenThread}
              onReact={() => setShowEmojiPicker((value) => !value)}
              onEdit={handleStartEdit}
              onMore={(event) => {
                msgMenu.openFromElement(event.currentTarget, message)
              }}
              expiryLabel={expiryLabel}
              threadLabel={threadActionLabel}
            />
            {showEmojiPicker && (
              <div className="vesper-message-emoji-popout">
                <EmojiPicker
                  anchorRef={reactionAnchorRef}
                  onSelect={(emoji, item) => handleReaction(item?.type === 'custom' ? formatCustomEmojiToken(item) : emoji)}
                  onClose={() => setShowEmojiPicker(false)}
                />
              </div>
            )}
          </div>
        </div>

        {!isThreadView && parentMessage && (
          <MessageReplyPreview
            authorName={replyAuthorName}
            preview={truncatedReplyPreview}
          />
        )}

        {startsGroup && (
          <div className="vesper-message-header">
            <button
              type="button"
              data-testid="message-sender"
              className="vesper-message-author vesper-message-author-clickable"
              onClick={handleOpenProfile}
            >
              {displayName}
            </button>
            <span className="vesper-message-time">{formatTime(message.inserted_at)}</span>
          </div>
        )}

        {isEditing ? (
          <div className="mt-1">
            <div className="rounded-xl border border-border bg-bg-secondary/70 px-3 py-2 text-sm text-text-secondary focus-within:border-accent/50">
              <VesperEditor
                mode="edit"
                initialValue={message.content}
                onSubmit={handleSaveEdit}
                onCancel={() => setEditingMessage(null)}
                placeholder="Edit message..."
                autoFocus
              />
            </div>
            <p className="mt-1 text-xs text-text-faintest">
              Enter to save · Escape to cancel
            </p>
          </div>
        ) : (
          <>
            {displayText && (
              <div data-testid="message-content" className="vesper-message-content text-text-secondary text-sm break-words whitespace-pre-wrap">
                {isUnavailableMessage ? (
                  <div className="vesper-message-unavailable">
                    <Lock className="vesper-message-unavailable-icon w-3.5 h-3.5" />
                    <div className="vesper-message-unavailable-title">{unavailableLabel}</div>
                  </div>
                ) : (
                  <Suspense fallback={<div>{displayText}</div>}>
                    <MarkdownContent content={displayText} />
                  </Suspense>
                )}
                {message.edited_at && (
                  <span data-testid="edited-marker" className="ml-1.5 text-xs text-text-faintest">(edited)</span>
                )}
              </div>
            )}

            {(isSending || isFailed) && (
              <div className="vesper-message-delivery-note">
                {isSending ? 'Sending...' : 'Not sent yet'}
              </div>
            )}

            {parsed.type === 'file' && (
              <FilePreview file={parsed.file} />
            )}

            {urls.map((url) => (
              <LinkPreview key={url} url={url} />
            ))}

            {!displayText && message.edited_at && (
              <span data-testid="edited-marker" className="text-text-faintest text-xs">(edited)</span>
            )}
          </>
        )}

        <MessageReactionBar
          reactions={message.reactions ?? []}
          currentUserId={myId ?? undefined}
          onToggleReaction={handleReaction}
          customEmojis={customEmojis}
        />

        {showThreadSummary && (
          <div className="vesper-message-thread-meta">
            <button
              data-testid="thread-link"
              type="button"
              onClick={handleOpenThread}
              className={`vesper-message-thread-link${isActiveThread ? ' vesper-message-thread-link-active' : ''}`}
            >
              <span data-testid="thread-count" className="inline-flex items-center gap-1.5">
                <MessageSquare className="w-3.5 h-3.5" />
                {threadSummaryLabel}
              </span>
            </button>
          </div>
        )}
      </div>

      {msgMenu.menu && (
        <ContextMenu
          x={msgMenu.menu.x}
          y={msgMenu.menu.y}
          anchorRect={msgMenu.menu.anchorRect}
          items={getMessageItems()}
          onClose={msgMenu.closeMenu}
        />
      )}

      {showProfile && message.sender_id && (
        <ProfilePopout
          user={{
            id: message.sender_id,
            username: (liveMember?.user?.username || message.sender?.username || 'unknown'),
            displayName,
            avatarUrl: avatarUrl ?? null,
            status,
            roleLabel: activeServer?.owner_id === message.sender_id
              ? 'Owner'
              : liveMember?.role ?? undefined,
            nickname: liveMember?.nickname,
            isCurrentUser: isMe
          }}
          anchorRect={profileAnchor}
          onClose={handleCloseProfile}
          onMessage={isMe ? undefined : async () => {
            await createConversation([message.sender_id!])
            setActiveServer(null)
            handleCloseProfile()
          }}
          onOpenSettings={isMe ? () => {
            handleCloseProfile()
            openSettingsModal()
          } : undefined}
        />
      )}
    </div>
  )
})
