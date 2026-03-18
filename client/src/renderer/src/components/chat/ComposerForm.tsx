import type {
  ChangeEventHandler,
  DragEventHandler,
  FormEventHandler,
  KeyboardEventHandler,
  MouseEventHandler,
  RefObject,
  UIEventHandler
} from 'react'
import { Loader2, Paperclip, SendHorizonal, Smile } from 'lucide-react'
import type { DmConversation } from '../../stores/dmStore'
import type { Message } from '../../stores/messageStore'
import type { Member, Server } from '../../stores/serverStore'
import type { PickerEmoji } from './EmojiPicker'
import EmojiPicker from './EmojiPicker'
import ComposerAutocomplete, { type ComposerAutocompleteItem } from './ComposerAutocomplete'
import ComposerRichTextPreview from './ComposerRichTextPreview'
import ComposerShell, { type StagedFile } from './message/ComposerShell'

interface Props {
  autocompleteItems: ComposerAutocompleteItem[]
  content: string
  conversation?: DmConversation | null
  dragActive: boolean
  emojiButtonRef: RefObject<HTMLButtonElement | null>
  encryptionError: string | null
  fileButtonTestId?: string
  fileInputRef: RefObject<HTMLInputElement | null>
  members: Member[]
  onAutocompleteHover: (index: number) => void
  onAutocompleteSelect: (item: ComposerAutocompleteItem) => void
  onCancelReply: () => void
  onClearEncryptionError: () => void
  onDragEnter: DragEventHandler<HTMLFormElement>
  onDragLeave: DragEventHandler<HTMLFormElement>
  onDrop: DragEventHandler<HTMLFormElement>
  onEmojiClose: () => void
  onEmojiSelect: (emoji: string, item?: PickerEmoji) => void
  onFileSelect: ChangeEventHandler<HTMLInputElement>
  onRemoveStagedFile: (id: string) => void
  onSubmit: FormEventHandler<HTMLFormElement>
  onTextareaChange: ChangeEventHandler<HTMLTextAreaElement>
  onTextareaClick: MouseEventHandler<HTMLTextAreaElement>
  onTextareaKeyDown: KeyboardEventHandler<HTMLTextAreaElement>
  onTextareaKeyUp: KeyboardEventHandler<HTMLTextAreaElement>
  onTextareaScroll: UIEventHandler<HTMLTextAreaElement>
  onToggleEmojiPicker: () => void
  placeholder: string
  previewRef: RefObject<HTMLDivElement | null>
  replyingTo: Message | null
  selectedAutocompleteIndex: number
  sendButtonTestId?: string
  server?: Server | null
  showEmojiPicker: boolean
  stagedFiles: StagedFile[]
  textareaRef: RefObject<HTMLTextAreaElement | null>
  textareaTestId?: string
  triggerQuery: string | null
  uploading: boolean
  canSend: boolean
}

export default function ComposerForm({
  autocompleteItems,
  content,
  conversation,
  dragActive,
  emojiButtonRef,
  encryptionError,
  fileButtonTestId,
  fileInputRef,
  members,
  onAutocompleteHover,
  onAutocompleteSelect,
  onCancelReply,
  onClearEncryptionError,
  onDragEnter,
  onDragLeave,
  onDrop,
  onEmojiClose,
  onEmojiSelect,
  onFileSelect,
  onRemoveStagedFile,
  onSubmit,
  onTextareaChange,
  onTextareaClick,
  onTextareaKeyDown,
  onTextareaKeyUp,
  onTextareaScroll,
  onToggleEmojiPicker,
  placeholder,
  previewRef,
  replyingTo,
  selectedAutocompleteIndex,
  sendButtonTestId,
  server,
  showEmojiPicker,
  stagedFiles,
  textareaRef,
  textareaTestId,
  triggerQuery,
  uploading,
  canSend
}: Props): React.JSX.Element {
  const showRichPreview = /^```(?!mermaid\b)([^\n`]*)\n[\s\S]*\n```$/i.test(content)

  return (
    <form
      onSubmit={onSubmit}
      onDragEnter={onDragEnter}
      onDragOver={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
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

      {triggerQuery && autocompleteItems.length > 0 && (
        <ComposerAutocomplete
          anchorRef={textareaRef}
          query={triggerQuery}
          items={autocompleteItems}
          selectedIndex={selectedAutocompleteIndex}
          onSelect={onAutocompleteSelect}
          onHover={onAutocompleteHover}
        />
      )}

      <ComposerShell
        encryptionError={encryptionError}
        onClearEncryptionError={onClearEncryptionError}
        replyingTo={replyingTo}
        onCancelReply={onCancelReply}
        stagedFiles={stagedFiles}
        onRemoveStagedFile={onRemoveStagedFile}
      >
        <div className="vesper-composer-controls">
          <button
            data-testid={fileButtonTestId}
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
            multiple
            onChange={onFileSelect}
            className="hidden"
          />
          <div className="relative">
            <button
              ref={emojiButtonRef}
              type="button"
              onClick={onToggleEmojiPicker}
              className="vesper-composer-icon-button"
              title="Emoji"
            >
              <Smile className="w-5 h-5" />
            </button>
            {showEmojiPicker && (
              <EmojiPicker
                anchorRef={emojiButtonRef}
                onSelect={onEmojiSelect}
                onClose={onEmojiClose}
              />
            )}
          </div>
          <div className={`vesper-composer-input-stack${showRichPreview ? ' vesper-composer-input-stack-rich' : ''}`}>
            {showRichPreview && (
              <ComposerRichTextPreview
                containerRef={previewRef}
                content={content}
                members={members}
                conversation={conversation}
                server={server}
              />
            )}
            <textarea
              ref={textareaRef}
              data-testid={textareaTestId}
              value={content}
              onChange={onTextareaChange}
              onClick={onTextareaClick}
              onKeyUp={onTextareaKeyUp}
              onKeyDown={onTextareaKeyDown}
              onScroll={onTextareaScroll}
              placeholder={placeholder}
              rows={1}
              className={showRichPreview ? 'vesper-composer-textarea vesper-composer-textarea-rich' : 'vesper-composer-textarea'}
            />
          </div>
          <button
            data-testid={sendButtonTestId}
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
