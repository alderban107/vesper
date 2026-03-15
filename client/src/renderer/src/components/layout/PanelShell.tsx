import ResizeHandle from './ResizeHandle'

interface Props {
  side: 'left' | 'right'
  width: number
  onWidthChange: (nextWidth: number) => void
  children: React.ReactNode
}

export default function PanelShell({ side, width, onWidthChange, children }: Props): React.JSX.Element {
  const shellClassName = side === 'right'
    ? 'vesper-panel-shell vesper-panel-shell-right'
    : 'vesper-panel-shell vesper-panel-shell-left'

  return (
    <div className={shellClassName} style={{ width: `${width}px` }}>
      <ResizeHandle
        side={side}
        width={width}
        onWidthChange={onWidthChange}
      />
      {children}
    </div>
  )
}
