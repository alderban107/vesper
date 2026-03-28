import { createEditor } from 'slate'
import { withReact } from 'slate-react'
import { withHistory } from 'slate-history'
import { withInlineVoids } from './plugins/withInlineVoids'
import { withSoftBreak } from './plugins/withSoftBreak'
import type { emptyDocument } from './types'

export interface VesperEditorOptions {
  onSubmit: () => void
}

export function createVesperEditor(options: VesperEditorOptions) {
  const base = createEditor()
  const withPlugins = withSoftBreak(
    withInlineVoids(
      withReact(
        withHistory(base)
      )
    ),
    options.onSubmit
  )
  return withPlugins
}
