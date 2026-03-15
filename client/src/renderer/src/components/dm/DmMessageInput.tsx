import { useState, useRef, useCallback } from 'react'
import { Paperclip, SendHorizonal, Smile, Loader2 } from 'lucide-react'
import { useDmStore } from '../../stores/dmStore'
import { useMessageStore, cacheSentPlaintext } from '../../stores/messageStore'
import { apiUpload } from '../../api/client'
import { encryptFile } from '../../crypto/fileEncryption'
import { encodePayload } from '../../crypto/payload'
import { useCryptoStore } from '../../stores/cryptoStore'
import { pushToChannel } from '../../api/socket'
import { useAuthStore } from '../../stores/authStore'
import EmojiPicker from '../chat/EmojiPicker'
import ComposerShell from '../chat/message/ComposerShell'
import { formatCustomEmojiToken } from '../../utils/emoji'

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
  const canUseE2EE = useAuthStore((s) => s.canUseE2EE)

  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isTypingRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragDepthRef = useRef(0)
  const [dragActive, setDragActive] = useState(false)

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

  const uploadFile = async (file: File): Promise<void> => {
    if (!file || !conversationId) return
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

      const topic = `dm:${conversationId}`
      const crypto = useCryptoStore.getState()
      const replyTo = useMessageStore.getState().replyingTo
      const parentId = replyTo?.id || undefined
      const enc = crypto.hasGroup(conversationId)
        ? await crypto.encryptForChannel(conversationId, envelope)
        : null

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

      if (crypto.hasGroup(conversationId)) {
        await crypto.resetGroup(conversationId)
      }

      await crypto.createGroup(conversationId)
      if (crypto.hasGroup(conversationId)) {
        const conversation = useDmStore
          .getState()
          .conversations.find((entry) => entry.id === conversationId)
        const myId = useAuthStore.getState().user?.id

        if (conversation && myId) {
          for (const participant of conversation.participants) {
            if (participant.user_id === myId) continue
            const result = await crypto.handleJoinRequest(
              conversationId,
              participant.user_id,
              participant.user.username
            )
            if (!result) continue

            pushToChannel(topic, 'mls_commit', {
              commit_data: result.commitBytes
            })

            if (result.welcomeBytes) {
              pushToChannel(topic, 'mls_welcome', {
                recipient_id: participant.user_id,
                welcome_data: result.welcomeBytes
              })
            }
          }
        }

        const freshEncrypted = await crypto.encryptForChannel(conversationId, envelope)
        if (freshEncrypted) {
          cacheSentPlaintext(freshEncrypted.ciphertext, envelope)
          pushToChannel(topic, 'new_message', {
            ciphertext: freshEncrypted.ciphertext,
            mls_epoch: freshEncrypted.epoch,
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
            <span>Drop a file to send it in this DM</span>
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
            data-testid="file-upload-button"
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
            value={content}
            onChange={(e) => {
              setContent(e.target.value)
              handleTyping()
            }}
            onKeyDown={handleKeyDown}
            placeholder="Message this conversation"
            rows={1}
            className="vesper-composer-textarea"
            style={{ minHeight: '46px' }}
          />
          <button
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
