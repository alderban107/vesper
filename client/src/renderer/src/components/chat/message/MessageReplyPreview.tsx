import { CornerDownRight } from 'lucide-react'

interface Props {
  authorName: string
  preview: string
}

export default function MessageReplyPreview({ authorName, preview }: Props): React.JSX.Element {
  return (
    <div className="vesper-message-reply">
      <span className="vesper-message-reply-spine" aria-hidden="true">
        <CornerDownRight className="w-3 h-3" />
      </span>
      <span className="vesper-message-reply-author">{authorName}</span>
      <span className="vesper-message-reply-preview">{preview}</span>
    </div>
  )
}
