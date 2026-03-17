import type { CustomEmoji } from '../../../utils/emoji'
import { findCustomEmoji } from '../../../utils/emoji'

interface Props {
  value: string
  customEmojis?: CustomEmoji[]
  className?: string
  onClick?: () => void
  title?: string
}

export default function EmojiGlyph({
  value,
  customEmojis = [],
  className,
  onClick,
  title
}: Props): React.JSX.Element {
  const customEmoji = findCustomEmoji(value, customEmojis)
  const accessibleLabel = customEmoji ? `:${customEmoji.name}:` : title ?? value
  const content = customEmoji ? (
    <img
      src={customEmoji.url}
      alt={`:${customEmoji.name}:`}
      draggable={false}
      className="vesper-emoji-image"
      data-emoji-name={customEmoji.name}
    />
  ) : (
    <span className="vesper-emoji-text" aria-hidden="true">
      {value}
    </span>
  )

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={className ? `vesper-emoji-button ${className}` : 'vesper-emoji-button'}
        aria-label={accessibleLabel}
        title={title ?? accessibleLabel}
        data-emoji-name={customEmoji?.name}
      >
        {content}
      </button>
    )
  }

  return (
    <span
      className={className ? `vesper-emoji ${className}` : 'vesper-emoji'}
      role="img"
      aria-label={accessibleLabel}
      title={title ?? accessibleLabel}
      data-emoji-name={customEmoji?.name}
    >
      {content}
    </span>
  )
}
