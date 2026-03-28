import type { RenderElementProps } from 'slate-react'
import type { ChannelMentionElement } from '../types'

export default function ChannelMentionVoid({
  attributes,
  children,
  element,
}: RenderElementProps & { element: ChannelMentionElement }): React.JSX.Element {
  return (
    <span {...attributes} contentEditable={false} className="vesper-slate-inline-void vesper-slate-channel-mention">
      #{element.channelName}
      {children}
    </span>
  )
}
