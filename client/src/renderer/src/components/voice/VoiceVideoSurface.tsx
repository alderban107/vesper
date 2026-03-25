import { useEffect, useRef, useState } from 'react'

export function getInitials(displayName: string): string {
  return (
    displayName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '?'
  )
}

export type StreamSlot = 'camera_video' | 'share_video'

export interface StreamCard {
  key: string
  userId: string
  displayName: string
  avatarUrl: string | null
  stream: MediaStream
  slot: StreamSlot
  isLocal: boolean
  speaking: boolean
  muted: boolean
  hasShareAudio: boolean
  testId?: string
}

export interface ParticipantCard {
  id: string
  displayName: string
  avatarUrl: string | null
  speaking: boolean
  muted: boolean
  isLocal: boolean
  hasCamera: boolean
  hasShare: boolean
  hasShareAudio: boolean
}

export function getCallGridClass(count: number): string {
  if (count <= 1) {
    return 'vesper-voice-call-grid-single'
  }

  if (count === 2) {
    return 'vesper-voice-call-grid-dual'
  }

  if (count <= 4) {
    return 'vesper-voice-call-grid-quad'
  }

  return 'vesper-voice-call-grid-crowded'
}

export default function VoiceVideoSurface({
  stream,
  muted = false,
  className,
  displayName,
  avatarUrl,
  mirror = false,
  fit = 'cover',
  testId
}: {
  stream: MediaStream
  muted?: boolean
  className?: string
  displayName: string
  avatarUrl: string | null
  mirror?: boolean
  fit?: 'cover' | 'contain'
  testId?: string
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [ready, setReady] = useState(false)
  const initials = getInitials(displayName)

  useEffect(() => {
    if (!videoRef.current) {
      return
    }

    if (videoRef.current.srcObject !== stream) {
      videoRef.current.srcObject = stream
    }
    setReady(false)

    return () => {
      if (videoRef.current) {
        videoRef.current.srcObject = null
      }
    }
  }, [stream])

  return (
    <div className="vesper-voice-video-surface">
      {!ready && (
        <div className="vesper-voice-video-surface-overlay">
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="vesper-voice-video-surface-preview" />
          ) : null}
          <div className="vesper-voice-video-surface-fallback">{initials}</div>
        </div>
      )}
      <video
        ref={videoRef}
        data-testid={testId}
        autoPlay
        playsInline
        muted={muted}
        onLoadedData={() => setReady(true)}
        className={`${className ?? ''} ${mirror ? 'vesper-voice-video-surface-mirror' : ''} ${fit === 'contain' ? 'vesper-voice-video-surface-contain' : ''}`.trim()}
      />
    </div>
  )
}
