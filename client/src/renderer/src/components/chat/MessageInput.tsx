import { useState, useRef, useCallback } from 'react'
import { Paperclip, SendHorizonal, Smile, Loader2 } from 'lucide-react'
import { useServerStore } from '../../stores/serverStore'
import {
  useMessageStore,
  cacheSentPlaintext,
  ensureChannelGroupReady
} from '../../stores/messageStore'
import { apiUpload } from '../../api/client'
import { encryptFile } from '../../crypto/fileEncryption'
import { encodePayload } from '../../crypto/payload'
import { useCryptoStore } from '../../stores/cryptoStore'
import { pushToChannel } from '../../api/socket'
import { useAuthStore } from '../../stores/authStore'
import EmojiPicker from './EmojiPicker'
import MentionAutocomplete from './MentionAutocomplete'
import ComposerShell from './message/ComposerShell'
import { formatCustomEmojiToken } from '../../utils/emoji'

export default function MessageInput(): React.JSX.Element {
  const [content, setContent] = useState('')
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionStart, setMentionStart] = useState(0)
  const [uploading, setUploading] = useState(false)
  const activeChannelId = useServerStore((s) => s.activeChannelId)
  const sendMessage = useMessageStore((s) => s.sendMessage)
  const sendTypingStart = useMessageStore((s) => s.sendTypingStart)
  const sendTypingStop = useMessageStore((s) => s.sendTypingStop)
  const replyingTo = useMessageStore((s) => s.replyingTo)
  const setReplyingTo = useMessageStore((s) => s.setReplyingTo)
  const encryptionError = useMessageStore((s) => s.encryptionError)
  const canUseE2EE = useAuthStore((s) => s.canUseE2EE)

  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isTypingRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dragDepthRef = useRef(0)
  const [dragActive, setDragActive] = useState(false)

  const handleTyping = useCallback(() => {
    if (!activeChannelId) return

    if (!isTypingRef.current) {
      isTypingRef.current = true
      sendTypingStart(activeChannelId)
    }

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current)
    }

    typingTimeoutRef.current = setTimeout(() => {
      isTypingRef.current = false
      sendTypingStop(activeChannelId)
    }, 2000)
  }, [activeChannelId, sendTypingStart, sendTypingStop])

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!content.trim() || !activeChannelId) return

    sendMessage(activeChannelId, content.trim())
    setContent('')
    setMentionQuery(null)

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current)
    }
    if (isTypingRef.current) {
      isTypingRef.current = false
      sendTypingStop(activeChannelId)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    // Let mention autocomplete handle keys when open
    if (mentionQuery !== null && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Tab' || e.key === 'Enter')) {
      return // MentionAutocomplete handles these via document listener
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
    if (e.key === 'Escape') {
      if (mentionQuery !== null) {
        setMentionQuery(null)
      } else if (replyingTo) {
        setReplyingTo(null)
      }
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const value = e.target.value
    setContent(value)
    handleTyping()

    // Check for @ mention trigger
    const cursorPos = e.target.selectionStart
    const textBeforeCursor = value.slice(0, cursorPos)
    const atMatch = textBeforeCursor.match(/(^|\s)@(\w*)$/)

    if (atMatch) {
      setMentionQuery(atMatch[2])
      setMentionStart(cursorPos - atMatch[2].length - 1) // position of @
    } else {
      setMentionQuery(null)
    }
  }

  const handleMentionSelect = (syntax: string, _displayText: string): void => {
    const before = content.slice(0, mentionStart)
    const after = content.slice(mentionStart + (mentionQuery?.length ?? 0) + 1)
    setContent(before + syntax + ' ' + after)
    setMentionQuery(null)
    textareaRef.current?.focus()
  }

  const uploadFile = async (file: File): Promise<void> => {
    if (!activeChannelId) return
    if (!canUseE2EE) {
      useMessageStore.setState({
        encryptionError: 'Approve this device to send encrypted messages.'
      })
      return
    }

    setUploading(true)
    try {
      const fileData = await file.arrayBuffer()
      const encrypted = await encryptFile(fileData)
      const blob = new Blob([encrypted.ciphertext])
      const formData = new FormData()
      formData.append('file', blob, file.name)
      formData.append('encrypted', 'true')

      const res = await apiUpload('/api/v1/attachments', formData)
      if (!res.ok) return

      const data = await res.json()
      const attachmentId = data.attachment.id

      const envelope = encodePayload({
        v: 1,
        type: 'file',
        text: content.trim() || undefined,
        file: {
          id: attachmentId,
          name: file.name,
          content_type: file.type || 'application/octet-stream',
          size: file.size,
          key: encrypted.key,
          iv: encrypted.iv
        }
      })

      const topic = `chat:channel:${activeChannelId}`
      const crypto = useCryptoStore.getState()
      const replyTo = useMessageStore.getState().replyingTo
      const parentId = replyTo?.id || undefined
      if (!crypto.hasGroup(activeChannelId)) {
        const ready = await ensureChannelGroupReady(activeChannelId)
        if (!ready) {
          useMessageStore.setState({
            encryptionError: 'File could not be encrypted. Please try again.'
          })
          return
        }
      }

      if (crypto.hasGroup(activeChannelId)) {
        const enc = await crypto.encryptForChannel(activeChannelId, envelope)
        if (enc) {
          cacheSentPlaintext(enc.ciphertext, envelope)
          pushToChannel(topic, 'new_message', {
            ciphertext: enc.ciphertext,
            mls_epoch: enc.epoch,
            attachment_ids: [attachmentId],
            ...(parentId && { parent_message_id: parentId })
          })
          setContent('')
          useMessageStore.getState().setReplyingTo(null)
          return
        }
      }

      useMessageStore.setState({ encryptionError: 'File could not be encrypted. Please try again.' })
    } catch {
      // ignore
    } finally {
      setUploading(false)
    }
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    if (!file) return

    await uploadFile(file)

    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleDragEnter = (event: React.DragEvent<HTMLFormElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current += 1
    setDragActive(true)
  }

  const handleDragLeave = (event: React.DragEvent<HTMLFormElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) {
      setDragActive(false)
    }
  }

  const handleDrop = async (event: React.DragEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = 0
    setDragActive(false)

    const file = event.dataTransfer.files?.[0]
    if (!file || uploading) {
      return
    }

    await uploadFile(file)
  }

  return (
    <form
      onSubmit={handleSubmit}
      onDragEnter={handleDragEnter}
      onDragOver={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onDragLeave={handleDragLeave}
      onDrop={(event) => {
        void handleDrop(event)
      }}
      className={`vesper-composer-form${dragActive ? ' vesper-composer-form-dragging' : ''}`}
    >
      {dragActive && (
        <div className="vesper-composer-drop-overlay" aria-hidden="true">
          <div className="vesper-composer-drop-card">
            <Paperclip className="w-5 h-5" />
            <span>Drop a file to send it to this channel</span>
          </div>
        </div>
      )}
      {/* Mention autocomplete */}
      {mentionQuery !== null && (
        <div className="relative mb-1">
          <div className="absolute bottom-0 left-0 z-50">
            <MentionAutocomplete
              query={mentionQuery}
              onSelect={handleMentionSelect}
              onClose={() => setMentionQuery(null)}
            />
          </div>
        </div>
      )}

      <ComposerShell
        encryptionError={encryptionError}
        onClearEncryptionError={() => useMessageStore.setState({ encryptionError: null })}
        replyingTo={replyingTo}
        onCancelReply={() => setReplyingTo(null)}
      >
        <div className="vesper-composer-controls">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="vesper-composer-icon-button"
            title="Attach file"
          >
            {uploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Paperclip className="w-5 h-5" />}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            onChange={handleFileSelect}
            className="hidden"
          />
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowEmojiPicker(!showEmojiPicker)}
              className="vesper-composer-icon-button"
              title="Emoji"
            >
              <Smile className="w-5 h-5" />
            </button>
            {showEmojiPicker && (
              <div className="absolute bottom-12 left-0 z-50">
                <EmojiPicker
                  onSelect={(emoji, item) => {
                    const value = item?.type === 'custom' ? formatCustomEmojiToken(item) : emoji
                    setContent((prev) => prev + value)
                    setShowEmojiPicker(false)
                  }}
                  onClose={() => setShowEmojiPicker(false)}
                />
              </div>
            )}
          </div>
          <textarea
            ref={textareaRef}
            data-testid="message-input"
            value={content}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="Message this channel"
            rows={1}
            className="vesper-composer-textarea"
            style={{ minHeight: '46px' }}
          />
          <button
            data-testid="send-button"
            type="submit"
            disabled={!content.trim()}
            className="vesper-composer-send"
          >
            <SendHorizonal className="w-5 h-5" />
          </button>
        </div>
      </ComposerShell>
    </form>
  )
}
