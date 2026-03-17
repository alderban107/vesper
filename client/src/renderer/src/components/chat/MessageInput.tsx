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
import type { FilePayload } from '../../crypto/payload'
import { useCryptoStore } from '../../stores/cryptoStore'
import { pushToChannel } from '../../api/socket'
import { useAuthStore } from '../../stores/authStore'
import EmojiPicker from './EmojiPicker'
import ComposerAutocomplete from './ComposerAutocomplete'
import ComposerShell from './message/ComposerShell'
import type { StagedFile } from './message/ComposerShell'
import { formatCustomEmojiToken } from '../../utils/emoji'
import { extractVideoThumbnail } from '../../utils/videoThumbnail'
import { extractAudioMetadata } from '../../utils/audioMetadata'
import {
  applyAutocompleteSelection,
  buildChannelSuggestions,
  buildEmojiSuggestions,
  buildMentionSuggestions,
  detectComposerTrigger,
  type ComposerTriggerMatch
} from './composerAutocompleteUtils'
import type { Message } from '../../stores/messageStore'

let stagedIdCounter = 0
const EMPTY_MESSAGES: Message[] = []

export default function MessageInput(): React.JSX.Element {
  const [content, setContent] = useState('')
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [trigger, setTrigger] = useState<ComposerTriggerMatch | null>(null)
  const [selectedAutocompleteIndex, setSelectedAutocompleteIndex] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([])
  const activeChannelId = useServerStore((s) => s.activeChannelId)
  const servers = useServerStore((s) => s.servers)
  const activeServerId = useServerStore((s) => s.activeServerId)
  const sendMessage = useMessageStore((s) => s.sendMessage)
  const sendTypingStart = useMessageStore((s) => s.sendTypingStart)
  const sendTypingStop = useMessageStore((s) => s.sendTypingStop)
  const replyingTo = useMessageStore((s) => s.replyingTo)
  const setReplyingTo = useMessageStore((s) => s.setReplyingTo)
  const setEditingMessage = useMessageStore((s) => s.setEditingMessage)
  const encryptionError = useMessageStore((s) => s.encryptionError)
  const canUseE2EE = useAuthStore((s) => s.canUseE2EE)
  const myUserId = useAuthStore((s) => s.user?.id)
  const messages = useMessageStore((s) =>
    activeChannelId ? (s.messagesByChannel[activeChannelId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  )
  const activeServer = servers.find((server) => server.id === activeServerId)

  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isTypingRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const emojiButtonRef = useRef<HTMLButtonElement>(null)
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

  const stageFile = (file: File): void => {
    setStagedFiles((prev) => [...prev, { file, id: `staged-${++stagedIdCounter}` }])
  }

  const removeStagedFile = (id: string): void => {
    setStagedFiles((prev) => prev.filter((entry) => entry.id !== id))
  }

  const uploadAndSendFile = async (file: File, text: string | undefined): Promise<boolean> => {
    if (!activeChannelId) return false
    if (!canUseE2EE) {
      useMessageStore.setState({
        encryptionError: 'Approve this device to send encrypted messages.'
      })
      return false
    }

    const fileData = await file.arrayBuffer()
    const encrypted = await encryptFile(fileData)
    const blob = new Blob([encrypted.ciphertext])
    const formData = new FormData()
    formData.append('file', blob, file.name)
    formData.append('encrypted', 'true')

    const res = await apiUpload('/api/v1/attachments', formData)
    if (!res.ok) return false

    const data = await res.json()
    const attachmentId = data.attachment.id

    // Build the file payload fields
    const fileFields: FilePayload['file'] = {
      id: attachmentId,
      name: file.name,
      content_type: file.type || 'application/octet-stream',
      size: file.size,
      key: encrypted.key,
      iv: encrypted.iv
    }

    // Video thumbnail extraction + upload
    const isVideo = file.type.startsWith('video/')
    if (isVideo) {
      try {
        const thumb = await extractVideoThumbnail(file)
        if (thumb) {
          const thumbData = await thumb.blob.arrayBuffer()
          const thumbEncrypted = await encryptFile(thumbData)
          const thumbBlob = new Blob([thumbEncrypted.ciphertext])
          const thumbForm = new FormData()
          thumbForm.append('file', thumbBlob, 'thumbnail.jpg')
          thumbForm.append('encrypted', 'true')

          const thumbRes = await apiUpload('/api/v1/attachments', thumbForm)
          if (thumbRes.ok) {
            const thumbJson = await thumbRes.json()
            fileFields.thumbnail = {
              id: thumbJson.attachment.id,
              key: thumbEncrypted.key,
              iv: thumbEncrypted.iv
            }
            fileFields.duration = thumb.duration
          }
        }
      } catch {
        // Thumbnail extraction failed — video still uploads without one
      }
    }

    const attachmentIds = [attachmentId]
    if (fileFields.thumbnail) {
      attachmentIds.push(fileFields.thumbnail.id)
    }

    // Audio metadata extraction + cover art upload
    const isAudio = file.type.startsWith('audio/')
    if (isAudio) {
      try {
        const meta = await extractAudioMetadata(file)
        if (meta) {
          if (meta.duration) {
            fileFields.duration = meta.duration
          }
          const audioMeta: NonNullable<FilePayload['file']['audio_metadata']> = {}
          if (meta.title) audioMeta.title = meta.title
          if (meta.artist) audioMeta.artist = meta.artist
          if (meta.album) audioMeta.album = meta.album

          if (meta.coverBlob) {
            const coverData = await meta.coverBlob.arrayBuffer()
            const coverEncrypted = await encryptFile(coverData)
            const coverBlob = new Blob([coverEncrypted.ciphertext])
            const coverForm = new FormData()
            coverForm.append('file', coverBlob, 'cover.jpg')
            coverForm.append('encrypted', 'true')

            const coverRes = await apiUpload('/api/v1/attachments', coverForm)
            if (coverRes.ok) {
              const coverJson = await coverRes.json()
              audioMeta.cover = {
                id: coverJson.attachment.id,
                key: coverEncrypted.key,
                iv: coverEncrypted.iv
              }
              attachmentIds.push(coverJson.attachment.id)
            }
          }

          if (audioMeta.title || audioMeta.artist || audioMeta.album || audioMeta.cover) {
            fileFields.audio_metadata = audioMeta
          }
        }
      } catch {
        // Metadata extraction failed — audio still uploads without metadata
      }
    }

    const envelope = encodePayload({
      v: 1,
      type: 'file',
      text: text || undefined,
      file: fileFields
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
        return false
      }
    }

    if (crypto.hasGroup(activeChannelId)) {
      const enc = await crypto.encryptForChannel(activeChannelId, envelope)
      if (enc) {
        cacheSentPlaintext(enc.ciphertext, envelope)
        pushToChannel(topic, 'new_message', {
          ciphertext: enc.ciphertext,
          mls_epoch: enc.epoch,
          attachment_ids: attachmentIds,
          ...(parentId && { parent_message_id: parentId })
        })
        return true
      }
    }

    useMessageStore.setState({ encryptionError: 'File could not be encrypted. Please try again.' })
    return false
  }

  const autocompleteItems = trigger
    ? (
        trigger.type === 'mention'
          ? buildMentionSuggestions(trigger.query, useServerStore.getState().members)
          : trigger.type === 'channel'
            ? buildChannelSuggestions(trigger.query, activeServer)
            : buildEmojiSuggestions(trigger.query, activeServer)
      )
    : []

  const commitAutocompleteSelection = (index: number): void => {
    if (!trigger) {
      return
    }

    const item = autocompleteItems[index]
    if (!item) {
      return
    }

    const cursorPos = textareaRef.current?.selectionStart ?? content.length
    const next = applyAutocompleteSelection(
      content,
      trigger.start,
      cursorPos,
      item.value,
      item.type !== 'emoji'
    )
    setContent(next.value)
    setTrigger(null)
    setSelectedAutocompleteIndex(0)

    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(next.caret, next.caret)
    })
  }

  const updateAutocompleteState = (value: string, cursorPos: number): void => {
    const nextTrigger = detectComposerTrigger(value, cursorPos)
    setTrigger(nextTrigger)
    setSelectedAutocompleteIndex(0)
  }

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!activeChannelId) return

    const hasText = content.trim().length > 0
    const hasFiles = stagedFiles.length > 0

    if (!hasText && !hasFiles) return

    // If there are staged files, upload them
    if (hasFiles) {
      setUploading(true)
      try {
        // First file gets the text caption, rest are sent without text
        for (let i = 0; i < stagedFiles.length; i++) {
          const text = i === 0 ? content.trim() : undefined
          const ok = await uploadAndSendFile(stagedFiles[i].file, text)
          if (!ok) {
            setUploading(false)
            return
          }
        }
        setStagedFiles([])
        setContent('')
        useMessageStore.getState().setReplyingTo(null)
      } catch {
        // ignore
      } finally {
        setUploading(false)
      }
    } else {
      // Text-only message
      sendMessage(activeChannelId, content.trim())
      setContent('')
    }

    setTrigger(null)
    setSelectedAutocompleteIndex(0)

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current)
    }
    if (isTypingRef.current) {
      isTypingRef.current = false
      sendTypingStop(activeChannelId)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (trigger && autocompleteItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedAutocompleteIndex((current) => (current + 1) % autocompleteItems.length)
        return
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedAutocompleteIndex((current) =>
          current <= 0 ? autocompleteItems.length - 1 : current - 1
        )
        return
      }

      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        commitAutocompleteSelection(selectedAutocompleteIndex)
        return
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        setTrigger(null)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSubmit(e)
    }
    if (
      e.key === 'ArrowUp' &&
      !e.shiftKey &&
      !e.altKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !content &&
      stagedFiles.length === 0 &&
      !replyingTo &&
      !uploading &&
      textareaRef.current?.selectionStart === 0
    ) {
      const lastEditableMessage = [...messages]
        .reverse()
        .find((message) => message.sender_id === myUserId && !message.parent_message_id)

      if (lastEditableMessage) {
        e.preventDefault()
        setEditingMessage(lastEditableMessage)
      }
      return
    }
    if (e.key === 'Escape') {
      if (trigger !== null) {
        setTrigger(null)
      } else if (replyingTo) {
        setReplyingTo(null)
      }
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const value = e.target.value
    setContent(value)
    handleTyping()
    updateAutocompleteState(value, e.target.selectionStart)
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    if (file) {
      stageFile(file)
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }

    textareaRef.current?.focus()
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

  const handleDrop = (event: React.DragEvent<HTMLFormElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = 0
    setDragActive(false)

    const file = event.dataTransfer.files?.[0]
    if (file && !uploading) {
      stageFile(file)
    }
  }

  const canSend = content.trim().length > 0 || stagedFiles.length > 0

  return (
    <form
      onSubmit={(e) => { void handleSubmit(e) }}
      onDragEnter={handleDragEnter}
      onDragOver={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`vesper-composer-form${dragActive ? ' vesper-composer-form-dragging' : ''}`}
    >
      {dragActive && (
        <div className="vesper-composer-drop-overlay" aria-hidden="true">
          <div className="vesper-composer-drop-card">
            <Paperclip className="w-5 h-5" />
            <span>Drop a file to attach it</span>
          </div>
        </div>
      )}
      {trigger && autocompleteItems.length > 0 && (
        <ComposerAutocomplete
          anchorRef={textareaRef}
          query={trigger.query}
          items={autocompleteItems}
          selectedIndex={selectedAutocompleteIndex}
          onSelect={(item) => {
            const index = autocompleteItems.findIndex((entry) => entry.id === item.id)
            commitAutocompleteSelection(index)
          }}
          onHover={setSelectedAutocompleteIndex}
        />
      )}

      <ComposerShell
        encryptionError={encryptionError}
        onClearEncryptionError={() => useMessageStore.setState({ encryptionError: null })}
        replyingTo={replyingTo}
        onCancelReply={() => setReplyingTo(null)}
        stagedFiles={stagedFiles}
        onRemoveStagedFile={removeStagedFile}
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
              ref={emojiButtonRef}
              type="button"
              onClick={() => setShowEmojiPicker(!showEmojiPicker)}
              className="vesper-composer-icon-button"
              title="Emoji"
            >
              <Smile className="w-5 h-5" />
            </button>
            {showEmojiPicker && (
              <EmojiPicker
                anchorRef={emojiButtonRef}
                onSelect={(emoji, item) => {
                  const value = item?.type === 'custom' ? formatCustomEmojiToken(item) : emoji
                  setContent((prev) => prev + value)
                  setShowEmojiPicker(false)
                }}
                onClose={() => setShowEmojiPicker(false)}
              />
            )}
          </div>
          <textarea
            ref={textareaRef}
            data-testid="message-input"
            value={content}
            onChange={handleChange}
            onClick={(event) => updateAutocompleteState(event.currentTarget.value, event.currentTarget.selectionStart)}
            onKeyUp={(event) => updateAutocompleteState(event.currentTarget.value, event.currentTarget.selectionStart)}
            onKeyDown={handleKeyDown}
            placeholder="Message this channel"
            rows={1}
            className="vesper-composer-textarea"
            style={{ minHeight: '46px' }}
          />
          <button
            data-testid="send-button"
            type="submit"
            disabled={!canSend || uploading}
            className="vesper-composer-send"
          >
            <SendHorizonal className="w-5 h-5" />
          </button>
        </div>
      </ComposerShell>
    </form>
  )
}
