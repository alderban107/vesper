import { Children, isValidElement, type ReactNode } from 'react'

interface ReactMarkdownCodeProps {
  children?: ReactNode
  className?: string
}

export interface MarkdownCodeBlockData {
  code: string
  language: string | null
}

function flattenText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }

  if (Array.isArray(node)) {
    return node.map((entry) => flattenText(entry)).join('')
  }

  if (isValidElement(node)) {
    return flattenText((node.props as ReactMarkdownCodeProps).children)
  }

  return ''
}

export function extractMarkdownCodeBlock(children: ReactNode): MarkdownCodeBlockData | null {
  const codeElement = Children.toArray(children).find((child) => {
    if (!isValidElement<ReactMarkdownCodeProps>(child)) {
      return false
    }

    if (typeof child.type === 'string') {
      return child.type === 'code'
    }

    return typeof child.props.className === 'string' || child.props.children !== undefined
  })

  if (!codeElement || !isValidElement<ReactMarkdownCodeProps>(codeElement)) {
    return null
  }

  const className = typeof codeElement.props.className === 'string' ? codeElement.props.className : ''
  const languageMatch = /language-([a-z0-9_+.#-]+)/i.exec(className)
  const code = flattenText(codeElement.props.children).replace(/\n$/, '')

  return {
    code,
    language: languageMatch?.[1] ?? null
  }
}
