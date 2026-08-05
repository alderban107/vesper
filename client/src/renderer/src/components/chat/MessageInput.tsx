import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { Slate } from 'slate-react'
import { Editor, Transforms } from 'slate'
import { useServerStore } from '../../stores/serverStore'
import { useDmStore } from '../../stores/dmStore'
import { useMessageStore } from '../../stores/messageStore'
import { useAuthStore } from '../../stores/authStore'
import { useSettingsStore } from '../../stores/settingsStore'
import ComposerForm from './ComposerForm'
import type { StagedFile } from './message/ComposerShell'
import { createAnonymousFilename, resolveStagedFilename } from '../../utils/attachmentFilename'
import { formatCustomEmojiToken, type CustomEmoji } from '../../utils/emoji'
import { AttachmentPreparationError, prepareMessageAttachment } from '../../utils/messageAttachment'
import { stripExifData } from '../../utils/stripExif'
import {
  buildChannelSuggestions,
  buildEmojiSuggestions,
  buildMentionSuggestions,
} from './composerAutocompleteUtils'
import type { Message } from '../../stores/messageStore'
import { createVesperEditor } from './slate/createVesperEditor'
import { serializeToMarkdown } from './slate/serialize'
import { emptyDocument } from './slate/types'
import { detectSlateTrigger, insertAutocompleteResult } from './slate/autocomplete'
import { resetSlateEditor } from './slate/resetSlateEditor'
import VesperEditable from './slate/VesperEditable'

let stagedIdCounter = 0
const EMPTY_MESSAGES: Message[] = []

interface Props {
  scope: { kind: 'channel'; id: string } | { kind: 'dm'; id: string }
}

export default function MessageInput({ scope }: Props): React.JSX.Element {
  const [content, setContent] = useState('')
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [trigger, setTrigger] = useState<{ type: 'mention' | 'channel' | 'emoji'; query: string; start: number } | null>(null)
  const [selectedAutocompleteIndex, setSelectedAutocompleteIndex] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([])

  const scopeId = scope.id
  const isChannel = scope.kind === 'channel'

  const servers = useServerStore((s) => s.servers)
  const members = useServerStore((s) => s.members)
  const activeServerId = useServerStore((s) => s.activeServerId)
  const conversations = useDmStore((s) => s.conversations)
  const sendMessage = useMessageStore((s) => s.sendMessage)
  const sendDmMessage = useMessageStore((s) => s.sendDmMessage)
  const sendAttachmentMessage = useMessageStore((s) => s.sendAttachmentMessage)
  const sendTypingStart = useMessageStore((s) => s.sendTypingStart)
  const sendTypingStop = useMessageStore((s) => s.sendTypingStop)
  const sendDmTypingStart = useMessageStore((s) => s.sendDmTypingStart)
  const sendDmTypingStop = useMessageStore((s) => s.sendDmTypingStop)
  const replyingTo = useMessageStore((s) => s.replyingTo)
  const setReplyingTo = useMessageStore((s) => s.setReplyingTo)
  const setEditingMessage = useMessageStore((s) => s.setEditingMessage)
  const encryptionError = useMessageStore((s) => s.encryptionError)
  const canUseE2EE = useAuthStore((s) => s.canUseE2EE)
  const anonymizeFilenames = useSettingsStore((s) => s.anonFilenames)
  const myUserId = useAuthStore((s) => s.user?.id)
  const messages = useMessageStore((s) =>
    s.messagesByChannel[scopeId] ?? EMPTY_MESSAGES
  )
  const activeServer = servers.find((server) => server.id === activeServerId)
  const activeConversation = isChannel ? undefined : conversations.find((c) => c.id === scopeId)
  const fetchMembers = useServerStore((s) => s.fetchMembers)

  // Ensure members are loaded for @mention autocomplete
  useEffect(() => {
    if (isChannel && activeServerId && members.length === 0) {
      void fetchMembers(activeServerId)
    }
  }, [isChannel, activeServerId, members.length, fetchMembers])

  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isTypingRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const emojiButtonRef = useRef<HTMLButtonElement>(null)
  const editorContainerRef = useRef<HTMLDivElement>(null)
  const dragDepthRef = useRef(0)
  const [dragActive, setDragActive] = useState(false)

  // Slate editor — stable across re-renders, new instance on scope change
  const editor = useMemo(() => {
    const ed = createVesperEditor({ onSubmit: () => {} })
    ed.children = emptyDocument()
    return ed
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeId])

  const slateValue = useMemo(() => emptyDocument(), [scopeId])

  // --- Typing indicators ---
  const handleTyping = useCallback(() => {
    if (!isTypingRef.current) {
      isTypingRef.current = true
      if (isChannel) sendTypingStart(scopeId)
      else sendDmTypingStart(scopeId)
    }
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
    typingTimeoutRef.current = setTimeout(() => {
      isTypingRef.current = false
      if (isChannel) sendTypingStop(scopeId)
      else sendDmTypingStop(scopeId)
    }, 2000)
  }, [isChannel, scopeId, sendTypingStart, sendTypingStop, sendDmTypingStart, sendDmTypingStop])

  // --- File staging ---
  const stageFiles = useCallback((files: Iterable<File>): void => {
    const entries = Array.from(files)
    if (entries.length === 0) return
    setStagedFiles((prev) => {
      const existingKeys = new Set(
        prev.map((e) => `${e.file.name}:${e.file.size}:${e.file.lastModified}`)
      )
      const next = [...prev]
      for (const file of entries) {
        const key = `${file.name}:${file.size}:${file.lastModified}`
        if (!existingKeys.has(key)) {
          existingKeys.add(key)
          next.push({
            file,
            id: `staged-${++stagedIdCounter}`,
            anonymousName: createAnonymousFilename(file.name)
          })
        }
      }
      return next
    })
  }, [])

  const removeStagedFile = (id: string): void => {
    setStagedFiles((prev) => prev.filter((e) => e.id !== id))
  }

  const toggleStagedFileSpoiler = (id: string): void => {
    setStagedFiles((prev) =>
      prev.map((e) => e.id === id ? { ...e, spoiler: !e.spoiler } : e)
    )
  }

  const toggleStagedFileAnonymous = (id: string): void => {
    setStagedFiles((prev) =>
      prev.map((e) => e.id === id ? { ...e, anonymous: !e.anonymous } : e)
    )
  }

  const setStagedFileDeliveryState = (
    id: string,
    deliveryState: StagedFile['deliveryState']
  ): void => {
    setStagedFiles((files) => files.map((file) =>
      file.id === id ? { ...file, deliveryState } : file
    ))
  }

  const uploadAndSendFile = async (file: File, text: string | undefined): Promise<boolean> => {
    if (!canUseE2EE) {
      useMessageStore.setState({ encryptionError: 'Approve this device to send encrypted messages.' })
      return false
    }

    let preparedAttachment
    try {
      preparedAttachment = await prepareMessageAttachment(file)
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'This file could not be prepared for sending.'
      const orphanNotice = error instanceof AttachmentPreparationError && error.hasOrphanedUpload
        ? ' Unused encrypted uploads are removed automatically.'
        : ''
      useMessageStore.setState({
        encryptionError: `${message} The staged file is still available to retry.${orphanNotice}`
      })
      return false
    }

    const replyToId = useMessageStore.getState().replyingTo?.id
    const sent = await sendAttachmentMessage(
      scope,
      { type: 'file', text, file: preparedAttachment.file },
      preparedAttachment.attachmentIds,
      replyToId
    )

    if (!sent) {
      useMessageStore.setState({
        encryptionError: 'The file was uploaded but not sent. The staged file is still available to retry. Unused encrypted uploads are removed automatically.'
      })
    }

    return sent
  }

  // --- Autocomplete ---
  const autocompleteItems = trigger
    ? (
        trigger.type === 'mention'
          ? buildMentionSuggestions(trigger.query, members, isChannel ? undefined : activeConversation)
          : trigger.type === 'channel' && isChannel
            ? buildChannelSuggestions(trigger.query, activeServer)
            : trigger.type === 'emoji'
              ? buildEmojiSuggestions(trigger.query, activeServer)
              : []
      )
    : []

  const commitAutocompleteSelection = (index: number): void => {
    if (!trigger) return
    const item = autocompleteItems[index]
    if (!item) return
    insertAutocompleteResult(editor, item, trigger.start)
    setTrigger(null)
    setSelectedAutocompleteIndex(0)
  }

  const updateAutocompleteState = (): void => {
    const nextTrigger = detectSlateTrigger(editor)
    if (!isChannel && nextTrigger?.type === 'channel') {
      setTrigger(null)
    } else {
      setTrigger(nextTrigger)
    }
    setSelectedAutocompleteIndex(0)
  }

  // --- Editor helpers ---
  const clearEditor = (): void => {
    resetSlateEditor(editor)
    setContent('')
  }

  // --- Drag-and-drop ---
  useEffect(() => {
    const hasFiles = (dt: DataTransfer | null): boolean =>
      Boolean(dt?.types && Array.from(dt.types).includes('Files'))

    const onDragEnter = (e: DragEvent): void => {
      if (!hasFiles(e.dataTransfer)) return
      e.preventDefault()
      dragDepthRef.current += 1
      setDragActive(true)
    }
    const onDragOver = (e: DragEvent): void => {
      if (!hasFiles(e.dataTransfer)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      setDragActive(true)
    }
    const onDragLeave = (e: DragEvent): void => {
      if (!hasFiles(e.dataTransfer)) return
      e.preventDefault()
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0) setDragActive(false)
    }
    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e.dataTransfer)) return
      e.preventDefault()
      dragDepthRef.current = 0
      setDragActive(false)
      if (!uploading) stageFiles(Array.from(e.dataTransfer?.files ?? []))
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [stageFiles, uploading])

  // --- Submit ---
  const handleSubmit = async (): Promise<void> => {
    const markdown = serializeToMarkdown(editor.children).trim()
    const hasText = markdown.length > 0
    const hasFiles = stagedFiles.length > 0
    if (!hasText && !hasFiles) return

    if (hasFiles) {
      setUploading(true)
      let sendingEntryId: string | null = null
      try {
        for (let i = 0; i < stagedFiles.length; i++) {
          const text = i === 0 ? markdown : undefined
          const entry = stagedFiles[i]
          sendingEntryId = entry.id
          setStagedFileDeliveryState(entry.id, 'uploading')
          const privacySettings = useSettingsStore.getState()
          const effectiveEntry = {
            ...entry,
            anonymous: entry.anonymous || privacySettings.anonFilenames,
          }
          const finalName = resolveStagedFilename(effectiveEntry)
          let fileToSend = finalName !== entry.file.name
            ? new File([entry.file], finalName, { type: entry.file.type })
            : entry.file

          try {
            if (privacySettings.stripExif && fileToSend.type.startsWith('image/')) {
              fileToSend = await stripExifData(fileToSend)
            }
          } catch {
            setStagedFileDeliveryState(entry.id, 'failed')
            useMessageStore.setState({
              encryptionError: 'This image could not be prepared for sending. The staged file is still available to retry.'
            })
            return
          }

          const sent = await uploadAndSendFile(fileToSend, text)
          if (!sent) {
            setStagedFileDeliveryState(entry.id, 'failed')
            return
          }

          setStagedFiles((files) => files.filter((file) => file.id !== entry.id))
          if (i === 0 && hasText) clearEditor()
        }
        useMessageStore.getState().setReplyingTo(null)
      } catch {
        if (sendingEntryId) setStagedFileDeliveryState(sendingEntryId, 'failed')
        useMessageStore.setState({
          encryptionError: 'This file could not be prepared for sending. The staged file is still available to retry.'
        })
        return
      } finally {
        setUploading(false)
      }
    } else {
      const send = isChannel ? sendMessage : sendDmMessage
      const replyId = useMessageStore.getState().replyingTo?.id
      send(scopeId, markdown, replyId)
      clearEditor()
    }

    setTrigger(null)
    setSelectedAutocompleteIndex(0)
    useMessageStore.getState().setReplyingTo(null)
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
    if (isTypingRef.current) {
      isTypingRef.current = false
      if (isChannel) sendTypingStop(scopeId)
      else sendDmTypingStop(scopeId)
    }
  }

  // --- Key handling ---
  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (trigger && autocompleteItems.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSelectedAutocompleteIndex((c) => (c + 1) % autocompleteItems.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSelectedAutocompleteIndex((c) => c <= 0 ? autocompleteItems.length - 1 : c - 1)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        commitAutocompleteSelection(selectedAutocompleteIndex)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setTrigger(null)
        return
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void handleSubmit()
      return
    }

    if (
      event.key === 'ArrowUp' &&
      !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey &&
      !content && stagedFiles.length === 0 && !replyingTo && !uploading
    ) {
      const lastEditableMessage = [...messages]
        .reverse()
        .find((m) => m.sender_id === myUserId && !m.thread_root_message_id)
      if (lastEditableMessage) {
        event.preventDefault()
        setEditingMessage(lastEditableMessage)
      }
      return
    }

    if (event.key === 'Escape') {
      if (trigger !== null) setTrigger(null)
      else if (replyingTo) setReplyingTo(null)
    }
  }

  // --- Slate onChange ---
  const contentRef = useRef('')
  const handleSlateChange = useCallback(() => {
    const markdown = serializeToMarkdown(editor.children)
    if (markdown !== contentRef.current) {
      contentRef.current = markdown
      setContent(markdown)
      handleTyping()
    }
    updateAutocompleteState()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, handleTyping])

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>): void => {
    stageFiles(Array.from(e.target.files ?? []))
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault(); event.stopPropagation()
    dragDepthRef.current += 1; setDragActive(true)
  }
  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault(); event.stopPropagation()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragActive(false)
  }
  const handleDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault(); event.stopPropagation()
    dragDepthRef.current = 0; setDragActive(false)
    if (!uploading) stageFiles(Array.from(event.dataTransfer.files ?? []))
  }

  const canSend = content.trim().length > 0 || stagedFiles.length > 0
  const displayedStagedFiles = useMemo(
    () => anonymizeFilenames
      ? stagedFiles.map((entry) => ({ ...entry, anonymous: true }))
      : stagedFiles,
    [anonymizeFilenames, stagedFiles]
  )

  return (
    <Slate editor={editor} initialValue={slateValue} onChange={handleSlateChange}>
      <ComposerForm
        autocompleteItems={autocompleteItems}
        dragActive={dragActive}
        editorContainerRef={editorContainerRef}
        emojiButtonRef={emojiButtonRef}
        encryptionError={encryptionError}
        fileInputRef={fileInputRef}
        onAutocompleteHover={setSelectedAutocompleteIndex}
        onAutocompleteSelect={(item) => {
          const index = autocompleteItems.findIndex((e) => e.id === item.id)
          commitAutocompleteSelection(index)
        }}
        onCancelReply={() => setReplyingTo(null)}
        onClearEncryptionError={() => useMessageStore.setState({ encryptionError: null })}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onEmojiClose={() => setShowEmojiPicker(false)}
        onEmojiSelect={(emoji, item) => {
          // Ensure editor has focus and valid selection
          if (!editor.selection) {
            Transforms.select(editor, Editor.end(editor, []))
          }
          if (item?.type === 'custom') {
            const ce = item as CustomEmoji
            Transforms.insertNodes(editor, [
              {
                type: 'custom-emoji' as const,
                token: formatCustomEmojiToken(ce),
                name: ce.name,
                url: ce.url,
                animated: ce.animated ?? false,
                children: [{ text: '' }],
              },
              { text: ' ' },
            ], { at: editor.selection!, select: true })
          } else {
            Transforms.insertNodes(editor, [
              {
                type: 'emoji' as const,
                unicode: emoji,
                children: [{ text: '' }],
              },
              { text: ' ' },
            ], { at: editor.selection!, select: true })
          }
          Transforms.move(editor, { distance: 1 })
          setShowEmojiPicker(false)
        }}
        onFileSelect={handleFileSelect}
        onRemoveStagedFile={removeStagedFile}
        onToggleStagedFileSpoiler={toggleStagedFileSpoiler}
        onToggleStagedFileAnonymous={anonymizeFilenames ? undefined : toggleStagedFileAnonymous}
        onSend={() => { void handleSubmit() }}
        onToggleEmojiPicker={() => setShowEmojiPicker(!showEmojiPicker)}
        replyingTo={replyingTo}
        selectedAutocompleteIndex={selectedAutocompleteIndex}
        sendButtonTestId={isChannel ? 'send-button' : undefined}
        showEmojiPicker={showEmojiPicker}
        stagedFiles={displayedStagedFiles}
        triggerQuery={trigger?.query ?? null}
        uploading={uploading}
        canSend={canSend}
      >
        <VesperEditable
          placeholder={isChannel ? 'Message this channel' : 'Message this conversation'}
          onKeyDown={handleKeyDown}
          onPasteAsFile={(file) => stageFiles([file])}
          autoFocus
        />
      </ComposerForm>
    </Slate>
  )
}
