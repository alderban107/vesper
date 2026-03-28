import type {
  ChangeEventHandler,
  DragEventHandler,
  RefObject
} from 'react'
import { Loader2, Paperclip, SendHorizonal, Smile } from 'lucide-react'
import type { Message } from '../../stores/messageStore'
import type { PickerEmoji } from './EmojiPicker'
import EmojiPicker from './EmojiPicker'
import ComposerAutocomplete, { type ComposerAutocompleteItem } from './ComposerAutocomplete'
import ComposerShell, { type StagedFile } from './message/ComposerShell'

interface Props {
  autocompleteItems: ComposerAutocompleteItem[]
  dragActive: boolean
  editorContainerRef: RefObject<HTMLDivElement | null>
  emojiButtonRef: RefObject<HTMLButtonElement | null>
  encryptionError: string | null
  fileButtonTestId?: string
  fileInputRef: RefObject<HTMLInputElement | null>
  onAutocompleteHover: (index: number) => void
  onAutocompleteSelect: (item: ComposerAutocompleteItem) => void
  onCancelReply: () => void
  onClearEncryptionError: () => void
  onDragEnter: DragEventHandler<HTMLDivElement>
  onDragLeave: DragEventHandler<HTMLDivElement>
  onDrop: DragEventHandler<HTMLDivElement>
  onEmojiClose: () => void
  onEmojiSelect: (emoji: string, item?: PickerEmoji) => void
  onFileSelect: ChangeEventHandler<HTMLInputElement>
  onRemoveStagedFile: (id: string) => void
  onSend: () => void
  onToggleEmojiPicker: () => void
  replyingTo: Message | null
  selectedAutocompleteIndex: number
  sendButtonTestId?: string
  showEmojiPicker: boolean
  stagedFiles: StagedFile[]
  triggerQuery: string | null
  uploading: boolean
  canSend: boolean
  children: React.ReactNode
}

export default function ComposerForm({
  autocompleteItems,
  dragActive,
  editorContainerRef,
  emojiButtonRef,
  encryptionError,
  fileButtonTestId,
  fileInputRef,
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
  onSend,
  onToggleEmojiPicker,
  replyingTo,
  selectedAutocompleteIndex,
  sendButtonTestId,
  showEmojiPicker,
  stagedFiles,
  triggerQuery,
  uploading,
  canSend,
  children,
}: Props): React.JSX.Element {
  return (
    <div
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
          anchorRef={editorContainerRef}
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
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
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
              <Smile className="w-4 h-4" />
            </button>
            {showEmojiPicker && (
              <EmojiPicker
                anchorRef={emojiButtonRef}
                onSelect={onEmojiSelect}
                onClose={onEmojiClose}
              />
            )}
          </div>
          <div ref={editorContainerRef} className="vesper-composer-input-stack">
            {children}
          </div>
          <button
            data-testid={sendButtonTestId}
            type="button"
            onClick={onSend}
            disabled={!canSend || uploading}
            className="vesper-composer-send"
          >
            <SendHorizonal className="w-4 h-4" />
          </button>
        </div>
      </ComposerShell>
    </div>
  )
}
