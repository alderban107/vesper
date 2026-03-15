import { MessageSquare, MoreHorizontal, Pencil, Reply, SmilePlus, Trash2 } from 'lucide-react'

interface Props {
  canEdit: boolean
  onReply: () => void
  onThread?: () => void
  onReact: () => void
  onEdit: () => void
  onDelete: () => void
  onMore?: () => void
  expiryLabel?: string | null
  threadLabel?: string
}

export default function MessageActions({
  canEdit,
  onReply,
  onThread,
  onReact,
  onEdit,
  onDelete,
  onMore,
  expiryLabel,
  threadLabel
}: Props): React.JSX.Element {
  return (
    <div className="vesper-message-actions">
      {expiryLabel && (
        <span data-testid="expiry-label" className="vesper-message-action-meta" title={expiryLabel}>
          {expiryLabel}
        </span>
      )}

      <button
        data-testid="react-button"
        type="button"
        onClick={onReact}
        className="vesper-message-action-button"
        title="Add reaction"
        aria-label="Add reaction"
      >
        <SmilePlus className="w-4 h-4" />
      </button>

      <button
        type="button"
        onClick={onReply}
        className="vesper-message-action-button"
        title="Reply"
        aria-label="Reply"
      >
        <Reply className="w-4 h-4" />
      </button>

      {onThread && (
        <button
          data-testid="thread-button"
          type="button"
          onClick={onThread}
          className="vesper-message-action-button"
          title={threadLabel ?? 'Open thread'}
          aria-label={threadLabel ?? 'Open thread'}
        >
          <MessageSquare className="w-4 h-4" />
        </button>
      )}

      {canEdit && (
        <>
          <button
            data-testid="edit-message"
            type="button"
            onClick={onEdit}
            className="vesper-message-action-button"
            title="Edit message"
            aria-label="Edit message"
          >
            <Pencil className="w-4 h-4" />
          </button>

          <button
            data-testid="delete-message"
            type="button"
            onClick={onDelete}
            className="vesper-message-action-button vesper-message-action-button-danger"
            title="Delete message"
            aria-label="Delete message"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </>
      )}

      {onMore && (
        <button
          data-testid="message-menu-button"
          type="button"
          onClick={onMore}
          className="vesper-message-action-button"
          title="More actions"
          aria-label="More actions"
        >
          <MoreHorizontal className="w-4 h-4" />
        </button>
      )}
    </div>
  )
}
