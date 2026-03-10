import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import type { Message } from '../../../stores/messageStore'

interface Props {
  encryptionError: string | null
  onClearEncryptionError: () => void
  replyingTo: Message | null
  onCancelReply: () => void
  children: ReactNode
}

function getReplyAuthor(message: Message): string {
  return message.sender?.display_name || message.sender?.username || 'Unknown'
}

export default function ComposerShell({
  encryptionError,
  onClearEncryptionError,
  replyingTo,
  onCancelReply,
  children
}: Props): React.JSX.Element {
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

      <div className={replyingTo ? 'vesper-composer vesper-composer-has-reply' : 'vesper-composer'}>
        {replyingTo && (
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
