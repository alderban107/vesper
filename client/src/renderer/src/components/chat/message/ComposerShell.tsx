import type { ReactNode } from 'react'
import { FileIcon, X } from 'lucide-react'
import type { Message } from '../../../stores/messageStore'

export interface StagedFile {
  file: File
  id: string
}

interface Props {
  encryptionError: string | null
  onClearEncryptionError: () => void
  replyingTo: Message | null
  onCancelReply: () => void
  stagedFiles?: StagedFile[]
  onRemoveStagedFile?: (id: string) => void
  children: ReactNode
}

function getReplyAuthor(message: Message): string {
  return message.sender?.display_name || message.sender?.username || 'Unknown'
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function ComposerShell({
  encryptionError,
  onClearEncryptionError,
  replyingTo,
  onCancelReply,
  stagedFiles,
  onRemoveStagedFile,
  children
}: Props): React.JSX.Element {
  const hasStaged = stagedFiles && stagedFiles.length > 0
  const hasReply = !!replyingTo
  const hasTopContent = hasStaged || hasReply

  return (
    <div className="vesper-composer-wrap">
      {encryptionError && (
        <div className="vesper-composer-alert">
          <span>{encryptionError}</span>
          <button
            type="button"
            onClick={onClearEncryptionError}
            className="vesper-composer-alert-close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className={hasTopContent ? 'vesper-composer vesper-composer-has-reply' : 'vesper-composer'}>
        {hasStaged && (
          <div className="vesper-composer-staged-files">
            {stagedFiles.map((entry) => (
              <div key={entry.id} className="vesper-composer-staged-file" data-testid="staged-file">
                <FileIcon className="w-4 h-4 shrink-0 text-accent" />
                <span className="vesper-composer-staged-name" title={entry.file.name}>
                  {entry.file.name}
                </span>
                <span className="vesper-composer-staged-size">
                  {formatFileSize(entry.file.size)}
                </span>
                <button
                  type="button"
                  onClick={() => onRemoveStagedFile?.(entry.id)}
                  className="vesper-composer-staged-remove"
                  aria-label={`Remove ${entry.file.name}`}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {hasReply && (
          <div className="vesper-composer-reply">
            <div className="vesper-composer-reply-copy">
              <span className="vesper-composer-reply-label">Replying to</span>
              <span className="vesper-composer-reply-author">{getReplyAuthor(replyingTo)}</span>
              <span className="vesper-composer-reply-preview">{replyingTo.content?.slice(0, 96)}</span>
            </div>
            <button
              type="button"
              onClick={onCancelReply}
              className="vesper-composer-reply-close"
              aria-label="Cancel reply"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {children}
      </div>
    </div>
  )
}
