import { useEffect, useId, useState } from 'react'

interface Props {
  code: string
}

interface MermaidRenderState {
  error: string | null
  svg: string | null
}

let mermaidInitialized = false
const mermaidRenderCache = new Map<string, MermaidRenderState>()
const mermaidRenderTasks = new Map<string, Promise<MermaidRenderState>>()

function sanitizeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-')
}

export default function MermaidBlock({ code }: Props): React.JSX.Element {
  const reactId = useId()
  const [mode, setMode] = useState<'chart' | 'code'>('chart')
  const [state, setState] = useState<MermaidRenderState>(() => {
    return mermaidRenderCache.get(code) ?? { error: null, svg: null }
  })

  useEffect(() => {
    let cancelled = false

    const cached = mermaidRenderCache.get(code)
    if (cached) {
      setState(cached)
      return () => {
        cancelled = true
      }
    }

    void (async () => {
      try {
        let task = mermaidRenderTasks.get(code)
        if (!task) {
          task = (async () => {
            const mermaid = (await import('mermaid')).default

            if (!mermaidInitialized) {
              mermaid.initialize({
                startOnLoad: false,
                securityLevel: 'strict',
                theme: 'dark',
                fontFamily: 'inherit'
              })
              mermaidInitialized = true
            }

            const renderId = `vesper-mermaid-${sanitizeDomId(reactId)}`
            const result = await mermaid.render(renderId, code)
            const nextState = { error: null, svg: result.svg }
            mermaidRenderCache.set(code, nextState)
            mermaidRenderTasks.delete(code)
            return nextState
          })().catch((error) => {
            const message = error instanceof Error ? error.message : 'Mermaid failed to render.'
            const nextState = { error: message, svg: null }
            mermaidRenderCache.set(code, nextState)
            mermaidRenderTasks.delete(code)
            return nextState
          })
          mermaidRenderTasks.set(code, task)
        }

        if (!cancelled) {
          setState(await task)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Mermaid failed to render.'
        if (!cancelled) {
          setState({ error: message, svg: null })
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [code, reactId])

  const showChart = mode === 'chart' && !state.error && Boolean(state.svg)

  return (
    <div
      className={
        state.error
          ? 'vesper-mermaid-block vesper-mermaid-block-error'
          : 'vesper-mermaid-block'
      }
    >
      <div className="vesper-mermaid-toolbar">
        <div className="vesper-mermaid-toggle">
          <button
            type="button"
            className={mode === 'chart' ? 'vesper-mermaid-toggle-button is-active' : 'vesper-mermaid-toggle-button'}
            onClick={() => setMode('chart')}
            disabled={Boolean(state.error)}
          >
            Chart
          </button>
          <button
            type="button"
            className={mode === 'code' ? 'vesper-mermaid-toggle-button is-active' : 'vesper-mermaid-toggle-button'}
            onClick={() => setMode('code')}
          >
            Code
          </button>
        </div>
      </div>

      {state.error && <div className="vesper-mermaid-error-copy">{state.error}</div>}

      {showChart ? (
        <div
          className="vesper-mermaid-diagram"
          dangerouslySetInnerHTML={{ __html: state.svg ?? '' }}
        />
      ) : mode === 'chart' ? (
        <div className="vesper-mermaid-block-loading">Rendering diagram...</div>
      ) : (
        <pre className="vesper-markdown-pre">
          <code className="vesper-markdown-code-block">{code}</code>
        </pre>
      )}
    </div>
  )
}
