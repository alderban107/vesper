import type { CustomEmoji } from '../../../utils/emoji'
import { findCustomEmoji } from '../../../utils/emoji'

interface Props {
  value: string
  customEmojis?: CustomEmoji[]
  className?: string
}

export default function EmojiGlyph({
  value,
  customEmojis = [],
  className
}: Props): React.JSX.Element {
  const customEmoji = findCustomEmoji(value, customEmojis)

  if (customEmoji) {
    return (
      <img
        src={customEmoji.url}
        alt={`:${customEmoji.name}:`}
        className={className ?? 'vesper-inline-custom-emoji'}
      />
    )
  }

  return <span className={className}>{value}</span>
}
