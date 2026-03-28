import { createEditor } from 'slate'
import { withReact } from 'slate-react'
import { withHistory } from 'slate-history'
import { withInlineVoids } from './plugins/withInlineVoids'
import { withSoftBreak } from './plugins/withSoftBreak'
import { withBlockQuotes } from './plugins/withBlockQuotes'
import { withCodeBlocks } from './plugins/withCodeBlocks'
import { withMaxLength } from './plugins/withMaxLength'

export interface VesperEditorOptions {
  onSubmit: () => void
}

export function createVesperEditor(options: VesperEditorOptions) {
  const base = createEditor()
  const editor = withMaxLength(
    withCodeBlocks(
      withBlockQuotes(
        withSoftBreak(
          withInlineVoids(
            withReact(
              withHistory(base)
            )
          ),
          options.onSubmit
        )
      )
    )
  )
  return editor
}
