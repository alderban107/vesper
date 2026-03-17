import { useState, useRef, useCallback } from 'react'
import { Paperclip, SendHorizonal, Smile, Loader2 } from 'lucide-react'
import { useDmStore } from '../../stores/dmStore'
import { useServerStore } from '../../stores/serverStore'
import {
  useMessageStore,
  cacheSentPlaintext,
  getPreferredMlsJoinDeviceId
} from '../../stores/messageStore'
import { apiUpload } from '../../api/client'
import { encryptFile } from '../../crypto/fileEncryption'
import { encodePayload } from '../../crypto/payload'
import type { FilePayload } from '../../crypto/payload'
import { useCryptoStore } from '../../stores/cryptoStore'
import { pushToChannel } from '../../api/socket'
import { useAuthStore } from '../../stores/authStore'
import EmojiPicker from '../chat/EmojiPicker'
import ComposerAutocomplete from '../chat/ComposerAutocomplete'
import ComposerShell from '../chat/message/ComposerShell'
import type { StagedFile } from '../chat/message/ComposerShell'
import { formatCustomEmojiToken } from '../../utils/emoji'
import { extractVideoThumbnail } from '../../utils/videoThumbnail'
import { extractAudioMetadata } from '../../utils/audioMetadata'
import {
  applyAutocompleteSelection,
  buildEmojiSuggestions,
  buildMentionSuggestions,
  detectComposerTrigger,
  type ComposerTriggerMatch
} from '../chat/composerAutocompleteUtils'
import type { Message } from '../../stores/messageStore'

let stagedIdCounter = 0
const EMPTY_MESSAGES: Message[] = []

export default function DmMessageInput(): React.JSX.Element {
  const [content, setContent] = useState('')
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [trigger, setTrigger] = useState<ComposerTriggerMatch | null>(null)
  const [selectedAutocompleteIndex, setSelectedAutocompleteIndex] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([])
  const conversationId = useDmStore((s) => s.selectedConversationId)
  const conversations = useDmStore((s) => s.conversations)
  const servers = useServerStore((s) => s.servers)
  const activeServerId = useServerStore((s) => s.activeServerId)
  const sendDmMessage = useMessageStore((s) => s.sendDmMessage)
  const sendDmTypingStart = useMessageStore((s) => s.sendDmTypingStart)
  const sendDmTypingStop = useMessageStore((s) => s.sendDmTypingStop)
  const replyingTo = useMessageStore((s) => s.replyingTo)
  const setReplyingTo = useMessageStore((s) => s.setReplyingTo)
  const setEditingMessage = useMessageStore((s) => s.setEditingMessage)
  const encryptionError = useMessageStore((s) => s.encryptionError)
  const canUseE2EE = useAuthStore((s) => s.canUseE2EE)
  const myUserId = useAuthStore((s) => s.user?.id)
  const messages = useMessageStore((s) =>
    conversationId ? (s.messagesByChannel[conversationId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  )
  const activeConversation = conversations.find((conversation) => conversation.id === conversationId)
  const activeServer = servers.find((server) => server.id === activeServerId)

  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isTypingRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const emojiButtonRef = useRef<HTMLButtonElement>(null)
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

  const stageFile = (file: File): void => {
    setStagedFiles((prev) => [...prev, { file, id: `staged-dm-${++stagedIdCounter}` }])
  }

  const removeStagedFile = (id: string): void => {
    setStagedFiles((prev) => prev.filter((entry) => entry.id !== id))
  }

  const ensureDmGroup = async (topic: string): Promise<boolean> => {
    const crypto = useCryptoStore.getState()
    if (crypto.hasGroup(conversationId!)) return true

    await crypto.createGroup(conversationId!)
    if (!crypto.hasGroup(conversationId!)) return false

    const conversation = useDmStore
      .getState()
      .conversations.find((entry) => entry.id === conversationId)
    const myId = useAuthStore.getState().user?.id

    if (conversation && myId) {
      for (const participant of conversation.participants) {
        if (participant.user_id === myId) continue
        const preferredDeviceId = getPreferredMlsJoinDeviceId(topic, participant.user_id)
        const result = await crypto.handleJoinRequest(
          conversationId!,
          participant.user_id,
          participant.user.username,
          preferredDeviceId
        )
        if (!result) continue

        pushToChannel(topic, 'mls_commit', {
          commit_data: result.commitBytes
        })

        if (result.welcomeBytes) {
          pushToChannel(topic, 'mls_welcome', {
            recipient_id: participant.user_id,
            welcome_data: result.welcomeBytes,
            key_package_ref: result.keyPackageRef
          })
        }
      }
    }

    return crypto.hasGroup(conversationId!)
  }

  const uploadAndSendFile = async (file: File, text: string | undefined): Promise<boolean> => {
    if (!conversationId) return false
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
      text: text || null,
      file: fileFields
    })

    const topic = `dm:${conversationId}`
    const crypto = useCryptoStore.getState()
    const replyTo = useMessageStore.getState().replyingTo
    const parentId = replyTo?.id || undefined

    // Try encrypting with existing group
    const enc = crypto.hasGroup(conversationId)
      ? await crypto.encryptForChannel(conversationId, envelope)
      : null

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

    // Reset and create fresh group
    if (crypto.hasGroup(conversationId)) {
      await crypto.resetGroup(conversationId)
    }

    const groupReady = await ensureDmGroup(topic)
    if (!groupReady) {
      useMessageStore.setState({ encryptionError: 'File could not be encrypted. Please try again.' })
      return false
    }

    const freshEncrypted = await crypto.encryptForChannel(conversationId, envelope)
    if (freshEncrypted) {
      cacheSentPlaintext(freshEncrypted.ciphertext, envelope)
      pushToChannel(topic, 'new_message', {
        ciphertext: freshEncrypted.ciphertext,
        mls_epoch: freshEncrypted.epoch,
        attachment_ids: attachmentIds,
        ...(parentId && { parent_message_id: parentId })
      })
      return true
    }

    useMessageStore.setState({ encryptionError: 'File could not be encrypted. Please try again.' })
    return false
  }

  const autocompleteItems = trigger
    ? (
        trigger.type === 'mention'
          ? buildMentionSuggestions(trigger.query, useServerStore.getState().members, activeConversation)
          : trigger.type === 'emoji'
            ? buildEmojiSuggestions(trigger.query, activeServer)
            : []
      )
    : []

  const updateAutocompleteState = (value: string, cursorPos: number): void => {
    const nextTrigger = detectComposerTrigger(value, cursorPos)
    setTrigger(nextTrigger?.type === 'channel' ? null : nextTrigger)
    setSelectedAutocompleteIndex(0)
  }

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

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!conversationId) return

    const hasText = content.trim().length > 0
    const hasFiles = stagedFiles.length > 0

    if (!hasText && !hasFiles) return

    if (hasFiles) {
      setUploading(true)
      try {
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
      sendDmMessage(conversationId, content.trim())
      setContent('')
    }

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current)
    }
    if (isTypingRef.current) {
      isTypingRef.current = false
      sendDmTypingStop(conversationId)
    }
    setTrigger(null)
    setSelectedAutocompleteIndex(0)
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
    if (e.key === 'Escape' && replyingTo) {
      setReplyingTo(null)
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    if (file) {
      stageFile(file)
    }

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
        <div className="relative mb-1">
          <div data-testid="mention-autocomplete" className="absolute bottom-0 left-0 right-0 z-50">
            <ComposerAutocomplete
              items={autocompleteItems}
              selectedIndex={selectedAutocompleteIndex}
              onSelect={(item) => {
                const index = autocompleteItems.findIndex((entry) => entry.id === item.id)
                commitAutocompleteSelection(index)
              }}
              onHover={setSelectedAutocompleteIndex}
            />
          </div>
        </div>
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
            value={content}
            onChange={(e) => {
              setContent(e.target.value)
              handleTyping()
              updateAutocompleteState(e.target.value, e.target.selectionStart)
            }}
            onClick={(event) => updateAutocompleteState(event.currentTarget.value, event.currentTarget.selectionStart)}
            onKeyUp={(event) => updateAutocompleteState(event.currentTarget.value, event.currentTarget.selectionStart)}
            onKeyDown={handleKeyDown}
            placeholder="Message this conversation"
            rows={1}
            className="vesper-composer-textarea"
            style={{ minHeight: '46px' }}
          />
          <button
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
