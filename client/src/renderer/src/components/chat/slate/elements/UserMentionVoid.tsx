import type { RenderElementProps } from 'slate-react'
import type { UserMentionElement } from '../types'

export default function UserMentionVoid({
  attributes,
  children,
  element,
}: RenderElementProps & { element: UserMentionElement }): React.JSX.Element {
  return (
    <span {...attributes} contentEditable={false} className="vesper-slate-inline-void vesper-slate-mention">
      @{element.displayName}
      {children}
    </span>
  )
}
