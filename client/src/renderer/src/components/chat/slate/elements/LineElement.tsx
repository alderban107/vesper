import type { RenderElementProps } from 'slate-react'

export default function LineElement({
  attributes,
  children,
}: RenderElementProps): React.JSX.Element {
  return <div {...attributes}>{children}</div>
}
