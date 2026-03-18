import { useState, useRef, useCallback, useEffect } from 'react'
import { useDmStore } from '../../stores/dmStore'
import { useServerStore } from '../../stores/serverStore'
import {
  useMessageStore,
  cacheSentPlaintext,
  getPreferredMlsJoinDeviceId
} from '../../stores/messageStore'
import { encodePayload } from '@vesper/sdk/crypto'
import { useCryptoStore } from '../../stores/cryptoStore'
import { pushToChannel } from '@vesper/sdk/transport'
import { useAuthStore } from '../../stores/authStore'
import ComposerForm from '../chat/ComposerForm'
import type { StagedFile } from '../chat/message/ComposerShell'
import { formatCustomEmojiToken, type CustomEmoji } from '../../utils/emoji'
import { prepareMessageAttachment } from '../../utils/messageAttachment'
import {
  applyAutocompleteSelection,
  buildEmojiSuggestions,
  buildMentionSuggestions,
  detectComposerTrigger,
  serializeComposerMentions,
  type ComposerMentionDraft,
  type ComposerTriggerMatch
} from '../chat/composerAutocompleteUtils'
import type { Message } from '../../stores/messageStore'

let stagedIdCounter = 0
const EMPTY_MESSAGES: Message[] = []
const COMPOSER_MIN_HEIGHT = 56

export default function DmMessageInput(): React.JSX.Element {
  const [content, setContent] = useState('')
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [trigger, setTrigger] = useState<ComposerTriggerMatch | null>(null)
  const [mentionDrafts, setMentionDrafts] = useState<ComposerMentionDraft[]>([])
  const [selectedAutocompleteIndex, setSelectedAutocompleteIndex] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([])
  const conversationId = useDmStore((s) => s.selectedConversationId)
  const conversations = useDmStore((s) => s.conversations)
  const servers = useServerStore((s) => s.servers)
  const members = useServerStore((s) => s.members)
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
  const previewRef = useRef<HTMLDivElement>(null)
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

  const stageFiles = useCallback((files: Iterable<File>): void => {
    const entries = Array.from(files)
    if (entries.length === 0) {
      return
    }

    setStagedFiles((prev) => {
      const existingKeys = new Set(
        prev.map((entry) => `${entry.file.name}:${entry.file.size}:${entry.file.lastModified}`)
      )
      const next = [...prev]

      for (const file of entries) {
        const key = `${file.name}:${file.size}:${file.lastModified}`
        if (existingKeys.has(key)) {
          continue
        }

        existingKeys.add(key)
        next.push({ file, id: `staged-dm-${++stagedIdCounter}` })
      }

      return next
    })
  }, [])

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
            recipient_device_id: preferredDeviceId,
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

    const preparedAttachment = await prepareMessageAttachment(file)
    if (!preparedAttachment) return false

    const envelope = encodePayload({
      v: 1,
      type: 'file',
      text: text ?? null,
      file: preparedAttachment.file
    })
    const { attachmentIds } = preparedAttachment

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

  const syncPreviewScroll = (): void => {
    if (!previewRef.current || !textareaRef.current) {
      return
    }

    previewRef.current.scrollTop = textareaRef.current.scrollTop
    previewRef.current.scrollLeft = textareaRef.current.scrollLeft
  }

  useEffect(() => {
    if (!textareaRef.current) {
      return
    }

    const maxHeight = Math.max(Math.round(window.innerHeight * 0.5), COMPOSER_MIN_HEIGHT)
    textareaRef.current.style.height = '0px'
    textareaRef.current.style.height = `${Math.min(
      Math.max(textareaRef.current.scrollHeight, COMPOSER_MIN_HEIGHT),
      maxHeight
    )}px`
    syncPreviewScroll()
  }, [content])

  useEffect(() => {
    const hasFiles = (dataTransfer: DataTransfer | null): boolean =>
      Boolean(dataTransfer?.types && Array.from(dataTransfer.types).includes('Files'))

    const handleWindowDragEnter = (event: DragEvent): void => {
      if (!hasFiles(event.dataTransfer)) {
        return
      }

      event.preventDefault()
      dragDepthRef.current += 1
      setDragActive(true)
    }

    const handleWindowDragOver = (event: DragEvent): void => {
      if (!hasFiles(event.dataTransfer)) {
        return
      }

      event.preventDefault()
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy'
      }
      setDragActive(true)
    }

    const handleWindowDragLeave = (event: DragEvent): void => {
      if (!hasFiles(event.dataTransfer)) {
        return
      }

      event.preventDefault()
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0) {
        setDragActive(false)
      }
    }

    const handleWindowDrop = (event: DragEvent): void => {
      if (!hasFiles(event.dataTransfer)) {
        return
      }

      event.preventDefault()
      dragDepthRef.current = 0
      setDragActive(false)

      if (!uploading) {
        stageFiles(Array.from(event.dataTransfer?.files ?? []))
      }
    }

    window.addEventListener('dragenter', handleWindowDragEnter)
    window.addEventListener('dragover', handleWindowDragOver)
    window.addEventListener('dragleave', handleWindowDragLeave)
    window.addEventListener('drop', handleWindowDrop)

    return () => {
      window.removeEventListener('dragenter', handleWindowDragEnter)
      window.removeEventListener('dragover', handleWindowDragOver)
      window.removeEventListener('dragleave', handleWindowDragLeave)
      window.removeEventListener('drop', handleWindowDrop)
    }
  }, [stageFiles, uploading])
  const commitAutocompleteSelection = (index: number): void => {
    if (!trigger) {
      return
    }

    const item = autocompleteItems[index]
    if (!item) {
      return
    }

    const replacement =
      item.type === 'user'
        ? `@${item.label}`
        : item.type === 'everyone'
          ? '@everyone'
          : item.value
    const cursorPos = textareaRef.current?.selectionStart ?? content.length
    const next = applyAutocompleteSelection(
      content,
      trigger.start,
      cursorPos,
      replacement,
      item.type !== 'emoji'
    )
    setContent(next.value)
    if (item.type === 'user' || item.type === 'everyone') {
      setMentionDrafts((current) => [...current, { display: replacement, syntax: item.value }])
    }
    setTrigger(null)
    setSelectedAutocompleteIndex(0)

    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(next.caret, next.caret)
      syncPreviewScroll()
    })
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const value = e.target.value
    setContent(value)
    handleTyping()
    updateAutocompleteState(value, e.target.selectionStart)
    syncPreviewScroll()
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
          const serializedText = text ? serializeComposerMentions(text, mentionDrafts) : undefined
          const ok = await uploadAndSendFile(stagedFiles[i].file, serializedText)
          if (!ok) {
            setUploading(false)
            return
          }
        }
        setStagedFiles([])
        setContent('')
        setMentionDrafts([])
        useMessageStore.getState().setReplyingTo(null)
      } catch {
        // ignore
      } finally {
        setUploading(false)
      }
    } else {
      sendDmMessage(conversationId, serializeComposerMentions(content.trim(), mentionDrafts))
      setContent('')
      setMentionDrafts([])
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
    if (e.key === 'Escape') {
      if (trigger !== null) {
        setTrigger(null)
      } else if (replyingTo) {
        setReplyingTo(null)
      }
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>): void => {
    stageFiles(Array.from(e.target.files ?? []))

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

    if (!uploading) {
      stageFiles(Array.from(event.dataTransfer.files ?? []))
    }
  }

  const canSend = content.trim().length > 0 || stagedFiles.length > 0

  return (
    <ComposerForm
      autocompleteItems={autocompleteItems}
      content={content}
      conversation={activeConversation}
      dragActive={dragActive}
      emojiButtonRef={emojiButtonRef}
      encryptionError={encryptionError}
      fileButtonTestId="file-upload-button"
      fileInputRef={fileInputRef}
      members={members}
      onAutocompleteHover={setSelectedAutocompleteIndex}
      onAutocompleteSelect={(item) => {
        const index = autocompleteItems.findIndex((entry) => entry.id === item.id)
        commitAutocompleteSelection(index)
      }}
      onCancelReply={() => setReplyingTo(null)}
      onClearEncryptionError={() => useMessageStore.setState({ encryptionError: null })}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onEmojiClose={() => setShowEmojiPicker(false)}
      onEmojiSelect={(emoji, item) => {
        const value = item?.type === 'custom' ? formatCustomEmojiToken(item as CustomEmoji) : emoji
        setContent((prev) => prev + value)
        setShowEmojiPicker(false)
        requestAnimationFrame(() => {
          textareaRef.current?.focus()
          syncPreviewScroll()
        })
      }}
      onFileSelect={handleFileSelect}
      onRemoveStagedFile={removeStagedFile}
      onSubmit={(event) => { void handleSubmit(event) }}
      onTextareaChange={handleChange}
      onTextareaClick={(event) => updateAutocompleteState(event.currentTarget.value, event.currentTarget.selectionStart)}
      onTextareaKeyDown={handleKeyDown}
      onTextareaKeyUp={(event) => updateAutocompleteState(event.currentTarget.value, event.currentTarget.selectionStart)}
      onTextareaScroll={syncPreviewScroll}
      onToggleEmojiPicker={() => setShowEmojiPicker(!showEmojiPicker)}
      placeholder="Message this conversation"
      previewRef={previewRef}
      replyingTo={replyingTo}
      selectedAutocompleteIndex={selectedAutocompleteIndex}
      server={activeServer}
      showEmojiPicker={showEmojiPicker}
      stagedFiles={stagedFiles}
      textareaRef={textareaRef}
      triggerQuery={trigger?.query ?? null}
      uploading={uploading}
      canSend={canSend}
    />
  )
}
