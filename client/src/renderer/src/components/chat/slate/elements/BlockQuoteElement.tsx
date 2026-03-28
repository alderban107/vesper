import type { RenderElementProps } from 'slate-react'

export default function BlockQuoteElement({
  attributes,
  children,
}: RenderElementProps): React.JSX.Element {
  return (
    <div {...attributes} className="vesper-slate-blockquote">
      {children}
    </div>
  )
}
