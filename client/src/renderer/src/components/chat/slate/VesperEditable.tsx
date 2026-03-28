import { useCallback } from 'react'
import { Editable, type RenderElementProps, type RenderLeafProps } from 'slate-react'
import LineElement from './elements/LineElement'
import FormattedLeaf from './leaves/FormattedLeaf'

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
        case 'line':
          return <LineElement {...props} />
        // Phase 4: blockquote, code-block, code-block-line
        // Phase 3: emoji, custom-emoji, user-mention, channel-mention
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

  return (
    <Editable
      className="vesper-slate-editable"
      renderElement={renderElement}
      renderLeaf={renderLeaf}
      placeholder={placeholder}
      onKeyDown={onKeyDown}
      readOnly={readOnly}
      autoFocus={autoFocus}
      spellCheck
      data-testid="message-input"
    />
  )
}
