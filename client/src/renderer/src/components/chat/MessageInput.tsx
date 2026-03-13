import { useState, useRef, useCallback } from 'react'
import { Paperclip, SendHorizonal, Smile, X, Loader2 } from 'lucide-react'
import { useServerStore } from '../../stores/serverStore'
import { useMessageStore } from '../../stores/messageStore'
import { apiUpload } from '../../api/client'
import { encryptFile } from '../../crypto/fileEncryption'
import { encodePayload } from '../../crypto/payload'
import { useCryptoStore } from '../../stores/cryptoStore'
import { pushToChannel } from '../../api/socket'
import EmojiPicker from './EmojiPicker'
import MentionAutocomplete from './MentionAutocomplete'

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

  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isTypingRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    if (!file || !activeChannelId) return

    setUploading(true)
    try {
      // Read file and encrypt with AES-256-GCM
      const fileData = await file.arrayBuffer()
      const encrypted = await encryptFile(fileData)

      // Upload encrypted blob
      const blob = new Blob([encrypted.ciphertext])
      const formData = new FormData()
      formData.append('file', blob, file.name)
      formData.append('encrypted', 'true')

      const res = await apiUpload('/api/v1/attachments', formData)
      if (!res.ok) return

      const data = await res.json()
      const attachmentId = data.attachment.id

      // Build structured payload with AES key embedded
      const envelope = encodePayload({
        v: 1,
        type: 'file',
        text: content.trim() || null,
        file: {
          id: attachmentId,
          name: file.name,
          content_type: file.type || 'application/octet-stream',
          size: file.size,
          key: encrypted.key,
          iv: encrypted.iv
        }
      })

      // Send message with attachment_ids via channel
      const topic = `chat:channel:${activeChannelId}`
      const crypto = useCryptoStore.getState()
      const replyTo = useMessageStore.getState().replyingTo
      const parentId = replyTo?.id || undefined

      // Ensure MLS group exists
      if (!crypto.hasGroup(activeChannelId)) {
        await crypto.createGroup(activeChannelId)
      }

      if (crypto.hasGroup(activeChannelId)) {
        const enc = await crypto.encryptForChannel(activeChannelId, envelope)
        if (enc) {
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
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  return (
    <form onSubmit={handleSubmit} className="px-4 pb-4 pt-2 shrink-0">
      {/* Encryption error */}
      {encryptionError && (
        <div className="flex items-center gap-2 px-4 py-1.5 mb-1 bg-red-500/10 rounded-lg text-xs text-red-400 border border-red-500/20">
          <span>{encryptionError}</span>
          <button
            type="button"
            onClick={() => useMessageStore.setState({ encryptionError: null })}
            className="ml-auto text-red-400 hover:text-red-300 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Reply preview */}
      {replyingTo && (
        <div className="flex items-center gap-2 px-4 py-1.5 mb-1 bg-bg-tertiary/50 rounded-t-xl text-xs text-text-muted border-l-2 border-accent animate-slide-up">
          <span>Replying to</span>
          <span className="font-medium text-text-primary">
            {replyingTo.sender?.display_name || replyingTo.sender?.username || 'Unknown'}
          </span>
          <span className="truncate text-text-faint">
            {replyingTo.content?.slice(0, 80)}
          </span>
          <button
            type="button"
            onClick={() => setReplyingTo(null)}
            className="ml-auto text-text-faint hover:text-text-primary transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
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

      <div className={`bg-bg-secondary/80 flex items-end border border-border ${replyingTo ? 'rounded-b-xl' : 'rounded-xl'} relative`}>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="px-3 py-3 text-text-faint hover:text-text-primary transition-colors disabled:opacity-50"
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
            className="px-1 py-3 text-text-faint hover:text-text-primary transition-colors"
            title="Emoji"
          >
            <Smile className="w-5 h-5" />
          </button>
          {showEmojiPicker && (
            <div className="absolute bottom-12 left-0 z-50">
              <EmojiPicker
                onSelect={(emoji) => {
                  setContent((prev) => prev + emoji)
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
          placeholder="Send a message..."
          rows={1}
          className="flex-1 bg-transparent text-text-primary px-2 py-3 resize-none focus:outline-none placeholder-text-faintest text-sm max-h-32"
          style={{ minHeight: '44px' }}
        />
        <button
          data-testid="send-button"
          type="submit"
          disabled={!content.trim()}
          className="px-3 py-3 text-accent hover:text-accent-hover disabled:text-text-disabled transition-colors"
        >
          <SendHorizonal className="w-5 h-5" />
        </button>
      </div>
    </form>
  )
}
