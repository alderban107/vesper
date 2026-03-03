import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import { useServerStore } from '../../stores/serverStore'

interface Props {
  content: string
}

// Pre-process mention syntax into markdown links
function preprocessMentions(text: string, members: Array<{ user_id: string; user?: { username?: string; display_name?: string | null } }>): string {
  // Replace <@userId> with styled link
  let result = text.replace(/<@([0-9a-f-]{36})>/g, (_match, userId: string) => {
    const member = members.find((m) => m.user_id === userId)
    const name = member?.user?.display_name || member?.user?.username || 'Unknown'
    return `[@${name}](mention:${userId})`
  })

  // Replace <@everyone>
  result = result.replace(/<@everyone>/g, '[@everyone](mention:everyone)')

  return result
}

const components: Components = {
  p: ({ children }) => (
    <p className="text-text-secondary text-sm break-words whitespace-pre-wrap">{children}</p>
  ),
  strong: ({ children }) => <strong className="font-semibold text-text-primary">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="line-through text-text-muted">{children}</del>,
  code: ({ className, children }) => {
    // If it has a language className, it's inside a <pre> (code block)
    if (className) {
      return <code className={className}>{children}</code>
    }
    // Inline code
    return (
      <code className="bg-bg-tertiary rounded px-1.5 py-0.5 font-mono text-xs text-accent-text">
        {children}
      </code>
    )
  },
  pre: ({ children }) => (
    <pre className="bg-bg-base rounded-lg border border-border overflow-x-auto p-3 my-1 text-sm">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-accent/50 pl-3 text-text-muted italic my-1">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => {
    // Mention links
    if (href?.startsWith('mention:')) {
      return (
        <span className="bg-accent/20 text-accent rounded px-0.5 font-medium cursor-default">
          {children}
        </span>
      )
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent-text underline"
      >
        {children}
      </a>
    )
  },
  ul: ({ children }) => <ul className="list-disc list-inside my-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal list-inside my-0.5">{children}</ol>,
  li: ({ children }) => <li className="text-text-secondary text-sm">{children}</li>
}

export default function MarkdownContent({ content }: Props): React.JSX.Element {
  const members = useServerStore((s) => s.members)
  const processed = preprocessMentions(content, members)

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {processed}
    </ReactMarkdown>
  )
}
