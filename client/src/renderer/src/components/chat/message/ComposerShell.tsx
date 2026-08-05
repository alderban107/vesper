import { useEffect, useState, type ReactNode } from 'react'
import { Eye, EyeOff, Glasses, Trash2, FileIcon, X } from 'lucide-react'
import { parseMessageContent, type Message } from '../../../stores/messageStore'
import { resolveStagedFilename } from '../../../utils/attachmentFilename'

export interface StagedFile {
  file: File
  id: string
  spoiler?: boolean
  anonymous?: boolean
  anonymousName?: string
  deliveryState?: 'uploading' | 'failed'
}

interface Props {
  encryptionError: string | null
  onClearEncryptionError: () => void
  replyingTo: Message | null
  onCancelReply: () => void
  stagedFiles?: StagedFile[]
  onRemoveStagedFile?: (id: string) => void
  onToggleSpoiler?: (id: string) => void
  onToggleAnonymous?: (id: string) => void
  children: ReactNode
}

function getReplyAuthor(message: Message): string {
  return message.sender?.display_name || message.sender?.username || 'Unknown'
}

function cleanPreviewText(text: string): string {
  return text
    .replace(/<@([0-9a-f-]{36})>/g, '@user')
    .replace(/<@everyone>/g, '@everyone')
    .replace(/<#([0-9a-f-]{36})>/g, '#channel')
    .replace(/<a?:([a-zA-Z0-9_~-]{2,32}):[a-zA-Z0-9_-]+>/g, ':$1:')
}

function getReplyPreview(message: Message): string {
  const parsed = parseMessageContent(message.content || '')
  if (parsed.type === 'file') {
    return parsed.text || parsed.file.name || 'Sent a file'
  }
  return cleanPreviewText(parsed.text || '')
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/')
}

function StagedFileCard({
  entry,
  onRemove,
  onToggleSpoiler,
  onToggleAnonymous,
}: {
  entry: StagedFile
  onRemove: () => void
  onToggleSpoiler?: () => void
  onToggleAnonymous?: () => void
}): React.JSX.Element {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null)

  useEffect(() => {
    if (isImageFile(entry.file)) {
      const url = URL.createObjectURL(entry.file)
      setThumbnailUrl(url)
      return () => URL.revokeObjectURL(url)
    }
    if (isVideoFile(entry.file)) {
      const url = URL.createObjectURL(entry.file)
      const video = document.createElement('video')
      video.preload = 'metadata'
      video.muted = true
      video.src = url
      video.currentTime = 1
      video.onloadeddata = () => {
        const canvas = document.createElement('canvas')
        canvas.width = Math.min(video.videoWidth, 320)
        canvas.height = Math.round(canvas.width * (video.videoHeight / video.videoWidth))
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          setThumbnailUrl(canvas.toDataURL('image/jpeg', 0.7))
        }
        URL.revokeObjectURL(url)
      }
      video.onerror = () => URL.revokeObjectURL(url)
      return () => {
        video.src = ''
        URL.revokeObjectURL(url)
      }
    }
    return undefined
  }, [entry.file])

  const displayName = resolveStagedFilename(entry)
  const truncatedName = displayName.length > 24
    ? displayName.slice(0, 21) + '...'
    : displayName

  return (
    <div className={`vesper-staged-card${entry.anonymous ? ' vesper-staged-card-anon' : ''}`} data-testid="staged-file">
      <div className="vesper-staged-card-actions">
        {onToggleAnonymous && (
          <button
            type="button"
            onClick={onToggleAnonymous}
            className={`vesper-staged-card-action${entry.anonymous ? ' vesper-staged-card-action-active' : ''}`}
            title={entry.anonymous ? 'Use original filename' : 'Anonymize filename'}
          >
            <Glasses className="w-3.5 h-3.5" />
          </button>
        )}
        {onToggleSpoiler && (
          <button
            type="button"
            onClick={onToggleSpoiler}
            className={`vesper-staged-card-action${entry.spoiler ? ' vesper-staged-card-action-active' : ''}`}
            title={entry.spoiler ? 'Remove spoiler' : 'Mark as spoiler'}
          >
            {entry.spoiler ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        )}
        <button
          type="button"
          onClick={onRemove}
          className="vesper-staged-card-action vesper-staged-card-action-delete"
          aria-label={`Remove ${entry.file.name}`}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className={`vesper-staged-card-preview${entry.spoiler ? ' vesper-staged-card-spoiler' : ''}`}>
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt={entry.file.name}
            className="vesper-staged-card-thumbnail"
            draggable={false}
          />
        ) : (
          <div className="vesper-staged-card-icon">
            <FileIcon className="w-10 h-10" />
          </div>
        )}
        {entry.spoiler && (
          <div className="vesper-staged-card-spoiler-label">SPOILER</div>
        )}
      </div>

      <div className="vesper-staged-card-name" title={entry.file.name}>
        {truncatedName}
      </div>
      {entry.deliveryState && (
        <div
          data-testid="staged-file-status"
          className={entry.deliveryState === 'failed'
            ? 'vesper-staged-card-status vesper-staged-card-status-failed'
            : 'vesper-staged-card-status'}
        >
          {entry.deliveryState === 'uploading' ? 'Uploading…' : 'Upload failed. Retry.'}
        </div>
      )}
    </div>
  )
}

export default function ComposerShell({
  encryptionError,
  onClearEncryptionError,
  replyingTo,
  onCancelReply,
  stagedFiles,
  onRemoveStagedFile,
  onToggleSpoiler,
  onToggleAnonymous,
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
          <div className="vesper-staged-tray">
            {stagedFiles.map((entry) => (
              <StagedFileCard
                key={entry.id}
                entry={entry}
                onRemove={() => onRemoveStagedFile?.(entry.id)}
                onToggleSpoiler={onToggleSpoiler ? () => onToggleSpoiler(entry.id) : undefined}
                onToggleAnonymous={onToggleAnonymous ? () => onToggleAnonymous(entry.id) : undefined}
              />
            ))}
          </div>
        )}

        {hasReply && (
          <div className="vesper-composer-reply">
            <div className="vesper-composer-reply-copy">
              <span className="vesper-composer-reply-label">Replying to</span>
              <span className="vesper-composer-reply-author">{getReplyAuthor(replyingTo)}</span>
              <span className="vesper-composer-reply-preview">{getReplyPreview(replyingTo).slice(0, 96)}</span>
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
