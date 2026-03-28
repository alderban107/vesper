import type { RenderElementProps } from 'slate-react'
import type { CodeBlockElement as CodeBlockElementType } from '../types'

export default function CodeBlockElement({
  attributes,
  children,
  element,
}: RenderElementProps & { element: CodeBlockElementType }): React.JSX.Element {
  return (
    <div {...attributes} className="vesper-slate-code-block">
      {element.language && (
        <div className="vesper-slate-code-lang" contentEditable={false}>
          {element.language}
        </div>
      )}
      <pre>
        <code>{children}</code>
      </pre>
    </div>
  )
}
