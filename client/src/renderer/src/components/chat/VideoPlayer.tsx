import { Download, Film } from 'lucide-react'

interface VideoPlayerProps {
  src: string
  name: string
  sizeLabel: string
  onDownload: () => void
}

export default function VideoPlayer({
  src,
  name,
  sizeLabel,
  onDownload
}: VideoPlayerProps): React.JSX.Element {
  return (
    <div className="vesper-video-player">
      <div className="vesper-audio-preview-header">
        <div className="vesper-audio-preview-meta">
          <span className="vesper-audio-preview-icon">
            <Film className="w-4 h-4" />
          </span>
          <div className="vesper-audio-preview-copy">
            <span className="vesper-audio-preview-name">{name}</span>
            <span className="vesper-audio-preview-size">{sizeLabel}</span>
          </div>
        </div>
        <button
          type="button"
          className="vesper-audio-icon-button"
          onClick={onDownload}
          aria-label={`Download ${name}`}
          title="Download"
        >
          <Download className="w-4 h-4" />
        </button>
      </div>

      <div className="vesper-video-player-frame">
        <video
          className="vesper-video-player-surface"
          controls
          playsInline
          preload="metadata"
          src={src}
        />
      </div>
    </div>
  )
}
