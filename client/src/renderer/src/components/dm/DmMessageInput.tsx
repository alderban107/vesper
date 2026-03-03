import { useState, useRef, useCallback } from 'react'
import { Paperclip, SendHorizonal, Smile, X, Loader2 } from 'lucide-react'
import { useDmStore } from '../../stores/dmStore'
import { useMessageStore } from '../../stores/messageStore'
import { apiUpload } from '../../api/client'
import { encryptFile } from '../../crypto/fileEncryption'
import { useCryptoStore } from '../../stores/cryptoStore'
import { pushToChannel } from '../../api/socket'
import EmojiPicker from '../chat/EmojiPicker'

export default function DmMessageInput(): React.JSX.Element {
  const [content, setContent] = useState('')
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [uploading, setUploading] = useState(false)
  const conversationId = useDmStore((s) => s.selectedConversationId)
  const sendDmMessage = useMessageStore((s) => s.sendDmMessage)
  const sendDmTypingStart = useMessageStore((s) => s.sendDmTypingStart)
  const sendDmTypingStop = useMessageStore((s) => s.sendDmTypingStop)
  const replyingTo = useMessageStore((s) => s.replyingTo)
  const setReplyingTo = useMessageStore((s) => s.setReplyingTo)
  const encryptionError = useMessageStore((s) => s.encryptionError)

  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isTypingRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleTyping = useCallback(() => {
    if (!conversationId) return

    if (!isTypingRef.current) {
      isTypingRef.current = true
      sendDmTypingStart(conversationId)
    }

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current)
    }

    typingTimeoutRef.current = setTimeout(() => {
      isTypingRef.current = false
      sendDmTypingStop(conversationId)
    }, 2000)
  }, [conversationId, sendDmTypingStart, sendDmTypingStop])

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!content.trim() || !conversationId) return

    sendDmMessage(conversationId, content.trim())
    setContent('')

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current)
    }
    if (isTypingRef.current) {
      isTypingRef.current = false
      sendDmTypingStop(conversationId)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
    if (e.key === 'Escape' && replyingTo) {
      setReplyingTo(null)
    }
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    if (!file || !conversationId) return

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

      // Build JSON envelope with AES key
      const envelope = JSON.stringify({
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

      // Send message with attachment_ids via channel
      const topic = `dm:${conversationId}`
      const crypto = useCryptoStore.getState()
      const replyTo = useMessageStore.getState().replyingTo
      const parentId = replyTo?.id || undefined

      // Ensure MLS group exists
      if (!crypto.hasGroup(conversationId)) {
        await crypto.createGroup(conversationId)
      }

      if (crypto.hasGroup(conversationId)) {
        const enc = await crypto.encryptForChannel(conversationId, envelope)
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

      {replyingTo && (
        <div className="flex items-center gap-2 px-4 py-1.5 mb-1 bg-bg-tertiary/50 rounded-t-xl text-xs text-text-muted border-l-2 border-accent animate-slide-up">
          <span>Replying to</span>
          <span className="font-medium text-text-primary">
            {replyingTo.sender?.display_name || replyingTo.sender?.username || 'Unknown'}
          </span>
          <span className="truncate max-w-[300px] text-text-faint">
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
          value={content}
          onChange={(e) => {
            setContent(e.target.value)
            handleTyping()
          }}
          onKeyDown={handleKeyDown}
          placeholder="Send a message..."
          rows={1}
          className="flex-1 bg-transparent text-text-primary px-2 py-3 resize-none focus:outline-none placeholder-text-faintest text-sm max-h-32"
          style={{ minHeight: '44px' }}
        />
        <button
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
