import { useEffect, useId, useRef, useState } from 'react'
import { Download, Pause, Play, Volume2 } from 'lucide-react'

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0:00'
  }

  const rounded = Math.floor(seconds)
  const minutes = Math.floor(rounded / 60)
  const remainder = rounded % 60
  return `${minutes}:${remainder.toString().padStart(2, '0')}`
}

interface AudioPlayerProps {
  src: string
  name: string
  sizeLabel: string
  onDownload: () => void
}

export default function AudioPlayer({
  src,
  name,
  sizeLabel,
  onDownload
}: AudioPlayerProps): React.JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const rangeId = useId()
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) {
      return
    }

    const handleLoadedMetadata = (): void => {
      setDuration(audio.duration || 0)
    }

    const handleTimeUpdate = (): void => {
      setCurrentTime(audio.currentTime)
    }

    const handleEnded = (): void => {
      setIsPlaying(false)
      setCurrentTime(0)
    }

    const handlePause = (): void => {
      setIsPlaying(false)
    }

    const handlePlay = (): void => {
      setIsPlaying(true)
    }

    audio.addEventListener('loadedmetadata', handleLoadedMetadata)
    audio.addEventListener('timeupdate', handleTimeUpdate)
    audio.addEventListener('ended', handleEnded)
    audio.addEventListener('pause', handlePause)
    audio.addEventListener('play', handlePlay)

    return () => {
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata)
      audio.removeEventListener('timeupdate', handleTimeUpdate)
      audio.removeEventListener('ended', handleEnded)
      audio.removeEventListener('pause', handlePause)
      audio.removeEventListener('play', handlePlay)
    }
  }, [])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) {
      return
    }

    audio.pause()
    audio.currentTime = 0
    setIsPlaying(false)
    setCurrentTime(0)
    setDuration(0)
  }, [src])

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  const togglePlayback = async (): Promise<void> => {
    const audio = audioRef.current
    if (!audio) {
      return
    }

    if (audio.paused) {
      await audio.play()
      return
    }

    audio.pause()
  }

  return (
    <div className="vesper-audio-player">
      <audio ref={audioRef} preload="metadata" src={src} />

      <div className="vesper-audio-preview-header">
        <div className="vesper-audio-preview-meta">
          <span className="vesper-audio-preview-icon">
            <Volume2 className="w-4 h-4" />
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

      <div className="vesper-audio-player-controls">
        <button
          type="button"
          className={`vesper-audio-play-button${isPlaying ? ' vesper-audio-play-button-active' : ''}`}
          onClick={() => {
            void togglePlayback()
          }}
          aria-label={isPlaying ? 'Pause audio' : 'Play audio'}
        >
          {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
        </button>

        <div className="vesper-audio-player-track">
          <label htmlFor={rangeId} className="sr-only">
            Audio progress
          </label>
          <input
            id={rangeId}
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={Math.min(currentTime, duration || 0)}
            onChange={(event) => {
              const audio = audioRef.current
              const nextTime = Number(event.target.value)
              if (!audio || Number.isNaN(nextTime)) {
                return
              }

              audio.currentTime = nextTime
              setCurrentTime(nextTime)
            }}
            className="vesper-audio-scrubber"
            style={{ ['--vesper-audio-progress' as string]: `${progress}%` }}
          />
          <div className="vesper-audio-player-times">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
