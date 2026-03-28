import { useCallback } from 'react'
import { Editable, useSlateStatic, type RenderElementProps, type RenderLeafProps } from 'slate-react'
import { Editor, Transforms, type NodeEntry } from 'slate'
import LineElement from './elements/LineElement'
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

const PASTE_AS_FILE_THRESHOLD = 2000

interface Props {
  placeholder?: string
  onKeyDown?: (event: React.KeyboardEvent) => void
  onPasteAsFile?: (file: File) => void
  readOnly?: boolean
  autoFocus?: boolean
}

export default function VesperEditable({
  placeholder = 'Type a message...',
  onKeyDown,
  onPasteAsFile,
  readOnly = false,
  autoFocus = false,
}: Props): React.JSX.Element {
  const editor = useSlateStatic()

  // When clicking in the empty space of the editor (past the text),
  // place the cursor at the end of the line. Slate's default behavior
  // resolves clicks in empty space to offset 0 (start of line),
  // especially after inline void nodes (emoji).
  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement
      const editable = event.currentTarget

      // Only intercept clicks directly on a line div or the editable itself
      const isLineDiv = target.getAttribute('data-slate-node') === 'element' && target.parentElement === editable
      const isEditable = target === editable

      if (!isLineDiv && !isEditable) return

      // Don't intercept if the editor has no real content — let Slate focus normally
      const docText = Editor.string(editor, [])
      const hasVoids = Array.from(Editor.nodes(editor, {
        at: [],
        match: n => editor.isVoid(n as any),
      })).length > 0
      if (!docText && !hasVoids) return

      const clickY = event.clientY
      const lines = editable.querySelectorAll<HTMLElement>(':scope > [data-slate-node="element"]')

      for (let i = 0; i < lines.length; i++) {
        const rect = lines[i].getBoundingClientRect()
        if (clickY >= rect.top && clickY <= rect.bottom) {
          event.preventDefault()
          Transforms.select(editor, Editor.end(editor, [i]))
          // Ensure focus since we prevented default
          editable.focus()
          return
        }
      }

      if (isEditable) {
        event.preventDefault()
        Transforms.select(editor, Editor.end(editor, []))
        editable.focus()
      }
    },
    [editor]
  )
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

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      const text = event.clipboardData.getData('text/plain')
      if (text && text.length > PASTE_AS_FILE_THRESHOLD && onPasteAsFile) {
        event.preventDefault()
        const blob = new Blob([text], { type: 'text/plain' })
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const file = new File([blob], `paste-${timestamp}.txt`, { type: 'text/plain' })
        onPasteAsFile(file)
      }
    },
    [onPasteAsFile]
  )

  return (
    <Editable
      className="vesper-slate-editable"
      renderElement={renderElement}
      renderLeaf={renderLeaf}
      decorate={decorate}
      placeholder={placeholder}
      onMouseDown={handleMouseDown}
      onPaste={handlePaste}
      onKeyDown={onKeyDown}
      readOnly={readOnly}
      autoFocus={autoFocus}
      spellCheck
      data-testid="message-input"
    />
  )
}
