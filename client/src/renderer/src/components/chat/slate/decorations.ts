import { Text, type NodeEntry, type Range, Element } from 'slate'

/**
 * Decorate function for the Slate editor. Applies visual-only formatting
 * to text leaves based on inline markdown patterns. The document text
 * retains the raw markdown syntax — decorations just control how it renders.
 */
export function decorateMarkdown([node, path]: NodeEntry): Range[] {
  if (!Text.isText(node)) return []
  const { text } = node
  if (!text) return []

  const ranges: Range[] = []

  // Bold: **text** or __text__
  for (const match of text.matchAll(/(\*\*|__)(.+?)\1/g)) {
    const start = match.index!
    const delim = match[1].length
    const contentStart = start + delim
    const contentEnd = contentStart + match[2].length

    ranges.push({
      anchor: { path, offset: start },
      focus: { path, offset: start + delim },
      syntaxMark: true,
    } as Range & { syntaxMark: true })
    ranges.push({
      anchor: { path, offset: contentStart },
      focus: { path, offset: contentEnd },
      bold: true,
    } as Range & { bold: true })
    ranges.push({
      anchor: { path, offset: contentEnd },
      focus: { path, offset: contentEnd + delim },
      syntaxMark: true,
    } as Range & { syntaxMark: true })
  }

  // Italic: *text* or _text_ (but not ** or __)
  for (const match of text.matchAll(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g)) {
    const start = match.index!
    const content = match[1] ?? match[2]
    const contentStart = start + 1
    const contentEnd = contentStart + content.length

    ranges.push({
      anchor: { path, offset: start },
      focus: { path, offset: start + 1 },
      syntaxMark: true,
    } as Range & { syntaxMark: true })
    ranges.push({
      anchor: { path, offset: contentStart },
      focus: { path, offset: contentEnd },
      italic: true,
    } as Range & { italic: true })
    ranges.push({
      anchor: { path, offset: contentEnd },
      focus: { path, offset: contentEnd + 1 },
      syntaxMark: true,
    } as Range & { syntaxMark: true })
  }

  // Strikethrough: ~~text~~
  for (const match of text.matchAll(/~~(.+?)~~/g)) {
    const start = match.index!
    const contentStart = start + 2
    const contentEnd = contentStart + match[1].length

    ranges.push({
      anchor: { path, offset: start },
      focus: { path, offset: start + 2 },
      syntaxMark: true,
    } as Range & { syntaxMark: true })
    ranges.push({
      anchor: { path, offset: contentStart },
      focus: { path, offset: contentEnd },
      strikethrough: true,
    } as Range & { strikethrough: true })
    ranges.push({
      anchor: { path, offset: contentEnd },
      focus: { path, offset: contentEnd + 2 },
      syntaxMark: true,
    } as Range & { syntaxMark: true })
  }

  // Inline code: `text`
  for (const match of text.matchAll(/(?<!`)`(?!`)([^`]+?)(?<!`)`(?!`)/g)) {
    const start = match.index!
    const contentStart = start + 1
    const contentEnd = contentStart + match[1].length

    ranges.push({
      anchor: { path, offset: start },
      focus: { path, offset: start + 1 },
      syntaxMark: true,
    } as Range & { syntaxMark: true })
    ranges.push({
      anchor: { path, offset: contentStart },
      focus: { path, offset: contentEnd },
      inlineCode: true,
    } as Range & { inlineCode: true })
    ranges.push({
      anchor: { path, offset: contentEnd },
      focus: { path, offset: contentEnd + 1 },
      syntaxMark: true,
    } as Range & { syntaxMark: true })
  }

  // Spoiler: ||text||
  for (const match of text.matchAll(/\|\|(.+?)\|\|/g)) {
    const start = match.index!
    const contentStart = start + 2
    const contentEnd = contentStart + match[1].length

    ranges.push({
      anchor: { path, offset: start },
      focus: { path, offset: start + 2 },
      syntaxMark: true,
    } as Range & { syntaxMark: true })
    ranges.push({
      anchor: { path, offset: contentStart },
      focus: { path, offset: contentEnd },
      spoiler: true,
    } as Range & { spoiler: true })
    ranges.push({
      anchor: { path, offset: contentEnd },
      focus: { path, offset: contentEnd + 2 },
      syntaxMark: true,
    } as Range & { syntaxMark: true })
  }

  // Underline: __text__ (distinct from bold — Discord uses __ for underline)
  // Note: this overlaps with bold __. For simplicity, __text__ renders as bold
  // (matching the more common convention). True underline would need a separate syntax.

  // Links: https://... or http://...
  for (const match of text.matchAll(/https?:\/\/[^\s<>"]+/g)) {
    const start = match.index!
    const end = start + match[0].length

    ranges.push({
      anchor: { path, offset: start },
      focus: { path, offset: end },
      link: match[0],
    } as Range & { link: string })
  }

  return ranges
}
