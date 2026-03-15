import type { ReactionGroup } from '../../../stores/messageStore'
import type { CustomEmoji } from '../../../utils/emoji'
import EmojiGlyph from './EmojiGlyph'

interface Props {
  reactions: ReactionGroup[]
  currentUserId?: string
  onToggleReaction: (emoji: string) => void
  customEmojis?: CustomEmoji[]
}

export default function MessageReactionBar({
  reactions,
  currentUserId,
  onToggleReaction,
  customEmojis = []
}: Props): React.JSX.Element | null {
  if (reactions.length === 0) {
    return null
  }

  return (
    <div className="vesper-message-reactions">
      {reactions.map((reaction) => {
        const isMine = currentUserId ? reaction.senderIds.includes(currentUserId) : false

        return (
          <button
            data-testid="reaction-chip"
            key={reaction.emoji}
            type="button"
            onClick={() => onToggleReaction(reaction.emoji)}
            className={isMine ? 'vesper-message-reaction vesper-message-reaction-active' : 'vesper-message-reaction'}
          >
            <EmojiGlyph
              value={reaction.emoji}
              customEmojis={customEmojis}
              className="vesper-message-reaction-emoji"
            />
            <span>{reaction.senderIds.length}</span>
          </button>
        )
      })}
    </div>
  )
}
