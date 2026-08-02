import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { Slate, ReactEditor } from 'slate-react'
import { Editor, Transforms } from 'slate'
import { createVesperEditor } from './createVesperEditor'
import { serializeToMarkdown } from './serialize'
import { emptyDocument } from './types'
import { resetSlateEditor } from './resetSlateEditor'
import VesperEditable from './VesperEditable'

export interface VesperEditorHandle {
  submit: () => void
}

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

const VesperEditor = forwardRef<VesperEditorHandle, Props>(function VesperEditor({
  onSubmit,
  onCancel,
  onChange,
  onTypingStart,
  onTypingStop,
  placeholder,
  initialValue,
  mode = 'compose',
  autoFocus = false,
}: Props, ref): React.JSX.Element {
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
    if (mode === 'compose' && !markdown.trim()) return
    submitRef.current(markdown)

    if (mode === 'compose') {
      resetSlateEditor(ed)
    }
  }, [mode])

  const editor = useMemo(
    () => createVesperEditor({ onSubmit: handleSubmit }),
    [handleSubmit]
  )
  const editorRef = useRef<typeof editor>(editor)
  editorRef.current = editor

  useImperativeHandle(ref, () => ({
    submit: handleSubmit
  }), [handleSubmit])

  const initialSlateValue = useMemo(() => {
    if (initialValue) {
      return [{ type: 'line' as const, children: [{ text: initialValue }] }]
    }
    return emptyDocument()
  }, [initialValue])

  useEffect(() => {
    if (mode !== 'edit' || !autoFocus) return

    const frame = window.requestAnimationFrame(() => {
      const ed = editorRef.current
      if (!ed) return
      ReactEditor.focus(ed)
      Transforms.select(ed, {
        anchor: Editor.start(ed, []),
        focus: Editor.end(ed, []),
      })
    })

    return () => window.cancelAnimationFrame(frame)
  }, [autoFocus, mode, initialValue])

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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        const ed = editorRef.current
        if (ed) {
          event.preventDefault()
          Transforms.select(ed, {
            anchor: Editor.start(ed, []),
            focus: Editor.end(ed, []),
          })
        }
        return
      }

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
})

export default VesperEditor
