import { useCallback, useMemo, useRef } from 'react'
import { Slate, type ReactEditor } from 'slate-react'
import { Editor, Transforms, Node } from 'slate'
import { createVesperEditor } from './createVesperEditor'
import { serializeToMarkdown } from './serialize'
import { emptyDocument } from './types'
import VesperEditable from './VesperEditable'

interface Props {
  onSubmit: (markdown: string) => void
  onCancel?: () => void
  onChange?: (markdown: string) => void
  onTypingStart?: () => void
  onTypingStop?: () => void
  placeholder?: string
  initialValue?: string
  mode?: 'compose' | 'edit'
  autoFocus?: boolean
}

export default function VesperEditor({
  onSubmit,
  onCancel,
  onChange,
  onTypingStart,
  onTypingStop,
  placeholder,
  initialValue,
  mode = 'compose',
  autoFocus = false,
}: Props): React.JSX.Element {
  const submitRef = useRef(onSubmit)
  submitRef.current = onSubmit
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const typingStartRef = useRef(onTypingStart)
  typingStartRef.current = onTypingStart
  const typingStopRef = useRef(onTypingStop)
  typingStopRef.current = onTypingStop

  const handleSubmit = useCallback(() => {
    const ed = editorRef.current
    if (!ed) return
    const markdown = serializeToMarkdown(ed.children)
    if (!markdown.trim()) return
    submitRef.current(markdown)
    // Reset editor
    Transforms.delete(ed, {
      at: {
        anchor: Editor.start(ed, []),
        focus: Editor.end(ed, []),
      },
    })
    Transforms.removeNodes(ed, { at: [0], mode: 'highest' })
    Transforms.insertNodes(ed, emptyDocument()[0], { at: [0] })
    // Remove any extra nodes that might have been left
    while (ed.children.length > 1) {
      Transforms.removeNodes(ed, { at: [ed.children.length - 1] })
    }
    Transforms.select(ed, Editor.start(ed, []))
  }, [])

  const editor = useMemo(
    () => createVesperEditor({ onSubmit: handleSubmit }),
    [handleSubmit]
  )
  const editorRef = useRef<typeof editor>(editor)
  editorRef.current = editor

  const initialSlateValue = useMemo(() => {
    if (initialValue) {
      return [{ type: 'line' as const, children: [{ text: initialValue }] }]
    }
    return emptyDocument()
  }, [initialValue])

  const handleChange = useCallback(() => {
    const ed = editorRef.current
    if (!ed) return
    const markdown = serializeToMarkdown(ed.children)
    onChangeRef.current?.(markdown)

    if (markdown.trim()) {
      typingStartRef.current?.()
    } else {
      typingStopRef.current?.()
    }
  }, [])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        handleSubmit()
        return
      }

      if (event.key === 'Escape' && mode === 'edit') {
        event.preventDefault()
        onCancel?.()
        return
      }
    },
    [handleSubmit, mode, onCancel]
  )

  return (
    <Slate editor={editor} initialValue={initialSlateValue} onChange={handleChange}>
      <VesperEditable
        placeholder={placeholder}
        onKeyDown={handleKeyDown}
        autoFocus={autoFocus}
      />
    </Slate>
  )
}
