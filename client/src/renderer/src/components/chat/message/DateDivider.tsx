interface Props {
  label: string
}

export default function DateDivider({ label }: Props): React.JSX.Element {
  return (
    <div className="vesper-date-divider" role="separator" aria-label={label}>
      <span className="vesper-date-divider-line" aria-hidden="true" />
      <span className="vesper-date-divider-label">{label}</span>
      <span className="vesper-date-divider-line" aria-hidden="true" />
    </div>
  )
}
