import type { RenderElementProps } from 'slate-react'
import type { EmojiElement } from '../types'
import { emojiToTwemojiUrl, twemojiFallback } from '../../../../utils/twemoji'

export default function EmojiVoid({
  attributes,
  children,
  element,
}: RenderElementProps & { element: EmojiElement }): React.JSX.Element {
  const url = emojiToTwemojiUrl(element.unicode)

  return (
    <span {...attributes} contentEditable={false} className="vesper-slate-inline-void vesper-slate-emoji">
      {url ? (
        <img
          src={url}
          alt={element.unicode}
          draggable={false}
          className="vesper-emoji-image"
          onError={twemojiFallback}
        />
      ) : (
        <span className="vesper-emoji-text" aria-hidden="true">{element.unicode}</span>
      )}
      {children}
    </span>
  )
}
