export default function MessageSkeleton(): React.JSX.Element {
  return (
    <div className="vesper-message-skeleton">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="vesper-message-skeleton-row">
          <div className="vesper-message-skeleton-avatar skeleton" />
          <div className="vesper-message-skeleton-body">
            <div className="vesper-message-skeleton-name skeleton" />
            <div className="vesper-message-skeleton-line skeleton" />
            {i % 2 === 0 && <div className="vesper-message-skeleton-line-short skeleton" />}
          </div>
        </div>
      ))}
    </div>
  )
}
