import type { RenderLeafProps } from 'slate-react'

export default function FormattedLeaf({
  attributes,
  children,
  leaf,
}: RenderLeafProps): React.JSX.Element {
  let content = children

  if (leaf.bold) {
    content = <strong className="vesper-slate-bold">{content}</strong>
  }
  if (leaf.italic) {
    content = <em className="vesper-slate-italic">{content}</em>
  }
  if (leaf.underline) {
    content = <u className="vesper-slate-underline">{content}</u>
  }
  if (leaf.strikethrough) {
    content = <s className="vesper-slate-strikethrough">{content}</s>
  }
  if (leaf.inlineCode) {
    content = <code className="vesper-slate-inline-code">{content}</code>
  }
  if (leaf.spoiler) {
    content = <span className="vesper-slate-spoiler-composer">{content}</span>
  }
  if (leaf.blockquote) {
    content = <span className="vesper-slate-blockquote-text">{content}</span>
  }
  if (leaf.link) {
    content = <span className="vesper-slate-link">{content}</span>
  }
  if (leaf.syntaxMark) {
    content = <span className="vesper-slate-syntax-mark">{content}</span>
  }

  return <span {...attributes}>{content}</span>
}
