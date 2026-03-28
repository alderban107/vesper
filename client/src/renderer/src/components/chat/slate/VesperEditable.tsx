import { useCallback } from 'react'
import { Editable, type RenderElementProps, type RenderLeafProps } from 'slate-react'
import type { NodeEntry } from 'slate'
import LineElement from './elements/LineElement'
import BlockQuoteElement from './elements/BlockQuoteElement'
import CodeBlockElement from './elements/CodeBlockElement'
import EmojiVoid from './elements/EmojiVoid'
import CustomEmojiVoid from './elements/CustomEmojiVoid'
import UserMentionVoid from './elements/UserMentionVoid'
import ChannelMentionVoid from './elements/ChannelMentionVoid'
import FormattedLeaf from './leaves/FormattedLeaf'
import { decorateMarkdown } from './decorations'
import type {
  EmojiElement,
  CustomEmojiElement,
  UserMentionElement,
  ChannelMentionElement,
  CodeBlockElement as CodeBlockElementType,
} from './types'

interface Props {
  placeholder?: string
  onKeyDown?: (event: React.KeyboardEvent) => void
  readOnly?: boolean
  autoFocus?: boolean
}

export default function VesperEditable({
  placeholder = 'Type a message...',
  onKeyDown,
  readOnly = false,
  autoFocus = false,
}: Props): React.JSX.Element {
  const renderElement = useCallback(
    (props: RenderElementProps) => {
      switch (props.element.type) {
        case 'emoji':
          return <EmojiVoid {...props} element={props.element as EmojiElement} />
        case 'custom-emoji':
          return <CustomEmojiVoid {...props} element={props.element as CustomEmojiElement} />
        case 'user-mention':
          return <UserMentionVoid {...props} element={props.element as UserMentionElement} />
        case 'channel-mention':
          return <ChannelMentionVoid {...props} element={props.element as ChannelMentionElement} />
        case 'blockquote':
          return <BlockQuoteElement {...props} />
        case 'code-block':
          return <CodeBlockElement {...props} element={props.element as CodeBlockElementType} />
        case 'code-block-line':
          return <div {...props.attributes} className="vesper-slate-code-line">{props.children}</div>
        case 'line':
        default:
          return <LineElement {...props} />
      }
    },
    []
  )

  const renderLeaf = useCallback(
    (props: RenderLeafProps) => <FormattedLeaf {...props} />,
    []
  )

  const decorate = useCallback(
    (entry: NodeEntry) => decorateMarkdown(entry),
    []
  )

  return (
    <Editable
      className="vesper-slate-editable"
      renderElement={renderElement}
      renderLeaf={renderLeaf}
      decorate={decorate}
      placeholder={placeholder}
      onKeyDown={onKeyDown}
      readOnly={readOnly}
      autoFocus={autoFocus}
      spellCheck
      data-testid="message-input"
    />
  )
}
