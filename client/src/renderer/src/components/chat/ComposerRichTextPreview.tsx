import type { RefObject } from 'react'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import plaintext from 'highlight.js/lib/languages/plaintext'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import type { DmConversation } from '../../stores/dmStore'
import type { Member, Server } from '../../stores/serverStore'
import { findCustomEmoji, parseCustomEmojiToken, type CustomEmoji } from '../../utils/emoji'
import { serializeComposerMentions, type ComposerMentionDraft } from './composerAutocompleteUtils'
import { extractMarkdownCodeBlock } from './MarkdownCodeBlock'
import EmojiGlyph from './message/EmojiGlyph'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('css', css)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)
hljs.registerLanguage('plaintext', plaintext)
hljs.registerLanguage('text', plaintext)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('xml', xml)

interface Props {
  content: string
  members?: Member[]
  mentionDrafts?: ComposerMentionDraft[]
  conversation?: DmConversation | null
  server?: Server | null
  className?: string
  containerRef?: RefObject<HTMLDivElement | null>
}

interface MentionUserEntry {
  id: string
  username?: string
  display_name?: string | null
}

interface ComposerCodeFencePreview {
  code: string
  language: string
  markup: string
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function buildCodeFencePreview(content: string): ComposerCodeFencePreview | null {
  const match = /^```([^\n`]*)\n([\s\S]*?)\n```$/.exec(content)
  if (!match) {
    return null
  }

  const language = match[1].trim()
  const code = match[2]

  const highlighted = (() => {
    if (!code) {
      return ''
    }

    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value
    }

    return hljs.highlightAuto(code).value
  })()

  const openingFence = escapeHtml(`\`\`\`${language}`.trimEnd())
  const closingFence = escapeHtml('```')

  return {
    code,
    language,
    markup: [
      `<span class="vesper-composer-code-fence-mark">${openingFence}</span>`,
      highlighted || '',
      `<span class="vesper-composer-code-fence-mark">${closingFence}</span>`
    ].join('\n')
  }
}

function preprocessMentions(text: string, users: MentionUserEntry[]): string {
  let result = text.replace(/<@([0-9a-f-]{36})>/g, (_match, userId: string) => {
    const user = users.find((entry) => entry.id === userId)
    const name = user?.display_name || user?.username || 'unknown'
    return `[@${name}](mention:${userId})`
  })

  result = result.replace(/<@everyone>/g, '[@everyone](mention:everyone)')
  return result
}

function preprocessChannels(text: string, channels: Array<{ id: string; name: string }>): string {
  return text.replace(/<#([0-9a-f-]{36})>/g, (_match, channelId: string) => {
    const channel = channels.find((entry) => entry.id === channelId)
    const name = channel?.name || 'unknown-channel'
    return `[#${name}](channel:${channelId})`
  })
}

function preprocessCustomEmoji(text: string, customEmojis: CustomEmoji[]): string {
  return text.replace(/<(a?):([a-zA-Z0-9_~-]{2,32}):([a-zA-Z0-9_-]+)>/g, (match) => {
    const customEmoji = findCustomEmoji(match, customEmojis)
    if (!customEmoji) {
      const parsed = parseCustomEmojiToken(match)
      return parsed ? `:${parsed.name}:` : match
    }

    const encoded = encodeURIComponent(match)
    return `![${customEmoji.name}](emoji:${encoded})`
  })
}

function buildMentionUsers(
  members: Member[],
  conversation: DmConversation | null | undefined
): MentionUserEntry[] {
  const mentionUsers: MentionUserEntry[] = []

  for (const member of members) {
    if (!member.user) {
      continue
    }

    mentionUsers.push({
      id: member.user_id,
      username: member.user.username,
      display_name: member.user.display_name
    })
  }

  for (const participant of conversation?.participants ?? []) {
    mentionUsers.push({
      id: participant.user_id,
      username: participant.user.username,
      display_name: participant.user.display_name
    })
  }

  return mentionUsers.filter(
    (entry, index, collection) =>
      collection.findIndex((candidate) => candidate.id === entry.id) === index
  )
}

export default function ComposerRichTextPreview({
  content,
  members = [],
  mentionDrafts = [],
  conversation,
  server,
  className,
  containerRef
}: Props): React.JSX.Element {
  const codeFencePreview = buildCodeFencePreview(content)

  if (codeFencePreview) {
    return (
      <div
        ref={containerRef}
        data-testid="composer-rich-preview"
        aria-hidden="true"
        className={className ? `vesper-composer-rich-preview ${className}` : 'vesper-composer-rich-preview'}
      >
        <pre
          className="vesper-composer-code-fence-preview"
          dangerouslySetInnerHTML={{ __html: codeFencePreview.markup }}
        />
      </div>
    )
  }

  const customEmojis: CustomEmoji[] = server?.emojis ?? []
  const channels = server?.channels ?? []
  const mentionUsers = buildMentionUsers(members, conversation)
  const serializedContent = serializeComposerMentions(content, mentionDrafts)
  const processed = preprocessCustomEmoji(
    preprocessChannels(preprocessMentions(serializedContent, mentionUsers), channels),
    customEmojis
  )

  const components: Components = {
    p: ({ children }) => <p className="vesper-composer-markdown-paragraph">{children}</p>,
    strong: ({ children }) => <strong className="vesper-composer-markdown-strong">{children}</strong>,
    em: ({ children }) => <em className="vesper-composer-markdown-emphasis">{children}</em>,
    del: ({ children }) => <del className="vesper-composer-markdown-strike">{children}</del>,
    code: ({ inline, className: codeClassName, children }) => {
      if (!inline) {
        return <code className={codeClassName}>{children}</code>
      }

      return <code className="vesper-composer-markdown-code">{children}</code>
    },
    pre: ({ children }) => {
      const codeBlock = extractMarkdownCodeBlock(children)
      if (!codeBlock) {
        return <pre className="vesper-composer-markdown-pre">{children}</pre>
      }

      return (
        <div className="vesper-composer-markdown-code-container">
          {codeBlock.language && (
            <span className="vesper-composer-markdown-code-lang">{codeBlock.language}</span>
          )}
          <pre className="vesper-composer-markdown-pre">
            <code className="vesper-composer-markdown-code-block">{codeBlock.code}</code>
          </pre>
        </div>
      )
    },
    blockquote: ({ children }) => <blockquote className="vesper-composer-markdown-quote">{children}</blockquote>,
    ul: ({ children }) => <ul className="vesper-composer-markdown-list">{children}</ul>,
    ol: ({ children }) => <ol className="vesper-composer-markdown-list vesper-composer-markdown-list-ordered">{children}</ol>,
    li: ({ children }) => <li className="vesper-composer-markdown-list-item">{children}</li>,
    a: ({ href, children }) => {
      if (href?.startsWith('mention:')) {
        const isEveryone = href.endsWith('everyone')
        return (
          <span
            className={
              isEveryone
                ? 'vesper-composer-token vesper-composer-token-mention vesper-composer-token-everyone'
                : 'vesper-composer-token vesper-composer-token-mention'
            }
          >
            {children}
          </span>
        )
      }

      if (href?.startsWith('channel:')) {
        return (
          <span className="vesper-composer-token vesper-composer-token-channel">
            {children}
          </span>
        )
      }

      return <span className="vesper-composer-markdown-link">{children}</span>
    },
    img: ({ src, alt }) => {
      if (src?.startsWith('emoji:')) {
        const token = decodeURIComponent(src.slice('emoji:'.length))
        return (
          <EmojiGlyph
            value={token}
            customEmojis={customEmojis}
            className="vesper-composer-token-emoji"
            title={alt || token}
          />
        )
      }

      return <span>{alt || src || ''}</span>
    }
  }

  return (
    <div
      ref={containerRef}
      data-testid="composer-rich-preview"
      aria-hidden="true"
      className={className ? `vesper-composer-rich-preview ${className}` : 'vesper-composer-rich-preview'}
    >
      <div className="vesper-composer-rich-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {processed}
        </ReactMarkdown>
      </div>
    </div>
  )
}
