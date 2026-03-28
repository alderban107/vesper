import type { RenderElementProps } from 'slate-react'
import type { CustomEmojiElement } from '../types'

export default function CustomEmojiVoid({
  attributes,
  children,
  element,
}: RenderElementProps & { element: CustomEmojiElement }): React.JSX.Element {
  return (
    <span {...attributes} contentEditable={false} className="vesper-slate-inline-void vesper-slate-emoji">
      <img
        src={element.url}
        alt={`:${element.name}:`}
        draggable={false}
        className="vesper-emoji-image"
        data-emoji-name={element.name}
      />
      {children}
    </span>
  )
}
