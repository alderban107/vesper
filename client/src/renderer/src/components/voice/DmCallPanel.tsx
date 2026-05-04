import { useMemo, useState } from 'react'
import {
  HeadphoneOff,
  Headphones,
  Mic,
  MicOff,
  PhoneOff,
  ScreenShare,
  ScreenShareOff,
  Video,
  VideoOff,
  Volume2
} from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import { useDmStore, type DmConversation } from '../../stores/dmStore'
import { useVoiceStore } from '../../stores/voiceStore'
import Avatar from '../ui/Avatar'
import VoiceVideoSurface, {
  getCallGridClass,
  type StreamCard,
  type ParticipantCard,
  type StreamSlot
} from './VoiceVideoSurface'

const EMPTY_DM_PARTICIPANTS: DmConversation['participants'] = []

export default function DmCallPanel(): React.JSX.Element | null {
  const conversations = useDmStore((s) => s.conversations)
  const roomId = useVoiceStore((s) => s.roomId)
  const roomType = useVoiceStore((s) => s.roomType)
  const voiceState = useVoiceStore((s) => s.state)
  const participants = useVoiceStore((s) => s.participants)
  const remoteVolumes = useVoiceStore((s) => s.remoteVolumes)
  const connectionQuality = useVoiceStore((s) => s.connectionQuality)
  const roundTripMs = useVoiceStore((s) => s.roundTripMs)
  const errorMessage = useVoiceStore((s) => s.errorMessage)
  const muted = useVoiceStore((s) => s.muted)
  const deafened = useVoiceStore((s) => s.deafened)
  const cameraEnabled = useVoiceStore((s) => s.cameraEnabled)
  const screenShareEnabled = useVoiceStore((s) => s.screenShareEnabled)
  const localCameraStream = useVoiceStore((s) => s.localCameraStream)
  const localShareStream = useVoiceStore((s) => s.localShareStream)
  const remoteMediaStreams = useVoiceStore((s) => s.remoteMediaStreams)
  const shareAudioPreferred = useVoiceStore((s) => s.shareAudioPreferred)
  const setRemoteVolume = useVoiceStore((s) => s.setRemoteVolume)
  const setRemoteStreamVolume = useVoiceStore((s) => s.setRemoteStreamVolume)
  const toggleMute = useVoiceStore((s) => s.toggleMute)
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen)
  const toggleCamera = useVoiceStore((s) => s.toggleCamera)
  const toggleScreenShare = useVoiceStore((s) => s.toggleScreenShare)
  const disconnect = useVoiceStore((s) => s.disconnect)
  const myUserId = useAuthStore((s) => s.user?.id ?? null)

  const [focusedStreamKey, setFocusedStreamKey] = useState<string | null>(null)

  const isConnected = voiceState === 'connected' || voiceState === 'in_call'
  const isActiveCall = voiceState !== 'idle'
  const conversation = roomType === 'dm' && roomId
    ? conversations.find((c) => c.id === roomId) ?? null
    : null
  const hasConversation = Boolean(conversation)
  const conversationParticipants = conversation?.participants ?? EMPTY_DM_PARTICIPANTS

  const participantCards = useMemo<ParticipantCard[]>(
    () => {
      if (!hasConversation) return []

      return participants.map((participant) => {
        const dmParticipant = conversationParticipants.find(
          (p) => p.user_id === participant.user_id
        )
        const displayName =
          dmParticipant?.user.display_name ||
          dmParticipant?.user.username ||
          participant.user_id.slice(0, 8)
        const isLocal = participant.user_id === myUserId
        const hasCamera = isLocal
          ? Boolean(localCameraStream || participant.camera_video_track_id)
          : Boolean(participant.camera_video_track_id)
        const hasShare = isLocal
          ? Boolean(localShareStream || participant.share_video_track_id)
          : Boolean(participant.share_video_track_id)

        return {
          id: participant.user_id,
          displayName,
          avatarUrl: dmParticipant?.user.avatar_url ?? null,
          speaking: participant.speaking ?? false,
          muted: participant.muted,
          isLocal,
          hasCamera,
          hasShare,
          hasShareAudio: Boolean(participant.share_audio_track_id)
        }
      })
    },
    [conversationParticipants, hasConversation, localCameraStream, localShareStream, myUserId, participants]
  )

  const streamCards = useMemo<StreamCard[]>(() => {
    if (!hasConversation) return []

    const cards: StreamCard[] = []

    const pushCard = (
      userId: string,
      slot: StreamSlot,
      stream: MediaStream,
      isLocal: boolean
    ): void => {
      const dmParticipant = conversationParticipants.find((p) => p.user_id === userId)
      const participant = participants.find((p) => p.user_id === userId)
      const displayName =
        dmParticipant?.user.display_name ||
        dmParticipant?.user.username ||
        userId.slice(0, 8)

      cards.push({
        key: `${userId}:${slot}`,
        userId,
        displayName,
        avatarUrl: dmParticipant?.user.avatar_url ?? null,
        stream,
        slot,
        isLocal,
        speaking: participant?.speaking ?? false,
        muted: participant?.muted ?? false,
        hasShareAudio: Boolean(participant?.share_audio_track_id),
        testId: isLocal ? 'local-video' : `remote-video-${displayName}`
      })
    }

    if (myUserId && localShareStream) {
      pushCard(myUserId, 'share_video', localShareStream, true)
    }

    if (myUserId && localCameraStream) {
      pushCard(myUserId, 'camera_video', localCameraStream, true)
    }

    for (const [key, stream] of Object.entries(remoteMediaStreams)) {
      const [userId, rawSlot] = key.split(':')
      if ((rawSlot === 'camera_video' || rawSlot === 'share_video') && userId) {
        pushCard(userId, rawSlot, stream, false)
      }
    }

    return cards
  }, [conversationParticipants, hasConversation, localCameraStream, localShareStream, myUserId, participants, remoteMediaStreams])

  const orderedStreamCards = useMemo(() => {
    const shares = streamCards.filter((card) => card.slot === 'share_video')
    const cameras = streamCards.filter((card) => card.slot === 'camera_video')
    return [...shares, ...cameras]
  }, [streamCards])

  const voiceOnlyParticipants = participantCards.filter(
    (p) => !p.hasCamera && !p.hasShare
  )

  const focused = focusedStreamKey
    ? orderedStreamCards.find((c) => c.key === focusedStreamKey) ?? null
    : null

  const connectionQualityLabel = {
    good: 'Good',
    fair: 'Fair',
    poor: 'Poor',
    unknown: 'No data'
  }[connectionQuality]

  if (roomType !== 'dm' || !roomId || !isActiveCall || !conversation) return null

  return (
    <div className="vesper-voice-channel-panel">
      <div className="vesper-voice-channel-panel-header">
        <div className="vesper-voice-channel-panel-header-info">
          <h2 className="vesper-voice-channel-panel-title">
            {conversation.name || conversationParticipants
              .filter((p) => p.user_id !== myUserId)
              .map((p) => p.user.display_name || p.user.username)
              .join(', ')}
          </h2>
          <span className="vesper-voice-channel-panel-pill">
            {connectionQualityLabel}
            {roundTripMs !== null && ` · ${Math.round(roundTripMs)} ms`}
          </span>
          {errorMessage && <div className="vesper-voice-room-error">{errorMessage}</div>}
        </div>
      </div>

      {/* Video grid */}
      {orderedStreamCards.length > 0 && (
        <div className="vesper-voice-call-grid-wrap">
          {focused ? (
            <div className="vesper-voice-call-grid-focus">
              <VoiceVideoSurface
                key={focused.key}
                stream={focused.stream}
                muted={focused.isLocal}
                displayName={focused.displayName}
                avatarUrl={focused.avatarUrl}
                mirror={focused.isLocal && focused.slot === 'camera_video'}
                fit={focused.slot === 'share_video' ? 'contain' : 'cover'}
                testId={focused.testId}
              />
              <button
                type="button"
                className="vesper-voice-call-grid-unfocus"
                onClick={() => setFocusedStreamKey(null)}
              >
                Back to grid
              </button>
            </div>
          ) : (
            <div className={`vesper-voice-call-grid ${getCallGridClass(orderedStreamCards.length)}`}>
              {orderedStreamCards.map((card) => (
                <button
                  key={card.key}
                  type="button"
                  className="vesper-voice-call-grid-tile"
                  onClick={() => setFocusedStreamKey(card.key)}
                >
                  <VoiceVideoSurface
                    stream={card.stream}
                    muted={card.isLocal}
                    displayName={card.displayName}
                    avatarUrl={card.avatarUrl}
                    mirror={card.isLocal && card.slot === 'camera_video'}
                    fit={card.slot === 'share_video' ? 'contain' : 'cover'}
                    testId={card.testId}
                  />
                  <div className="vesper-voice-call-grid-tile-label">
                    <span className="vesper-voice-call-grid-tile-name">{card.displayName}</span>
                    {card.slot === 'share_video' && (
                      <span className="vesper-voice-call-grid-tile-badge">Screen</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Voice-only participants */}
      {voiceOnlyParticipants.length > 0 && (
        <div className="vesper-voice-channel-panel-participants">
          {voiceOnlyParticipants.map((p) => (
            <div
              key={p.id}
              className={`vesper-voice-channel-panel-participant ${p.speaking ? 'vesper-voice-channel-panel-participant-speaking' : ''}`}
            >
              <Avatar userId={p.id} displayName={p.displayName} avatarUrl={p.avatarUrl} size="md" />
              <span className="vesper-voice-channel-panel-participant-name">{p.displayName}</span>
              {p.muted && <MicOff className="w-4 h-4 text-text-faint" />}
              {!p.isLocal && (
                <div className="vesper-voice-channel-panel-participant-volume">
                  <Volume2 className="w-3.5 h-3.5 text-text-faint" />
                  <input
                    type="range"
                    min={0}
                    max={200}
                    value={remoteVolumes[p.id] ?? 100}
                    onChange={(e) => setRemoteVolume(p.id, Number(e.target.value))}
                    className="vesper-voice-slider"
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Controls */}
      <div className="vesper-voice-channel-panel-controls">
        <button
          type="button"
          onClick={toggleMute}
          className={`vesper-voice-btn ${muted ? 'vesper-voice-btn-danger' : ''}`}
          title={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
        </button>

        <button
          type="button"
          onClick={toggleDeafen}
          className={`vesper-voice-btn ${deafened ? 'vesper-voice-btn-danger' : ''}`}
          title={deafened ? 'Undeafen' : 'Deafen'}
        >
          {deafened ? <HeadphoneOff className="w-5 h-5" /> : <Headphones className="w-5 h-5" />}
        </button>

        <button
          type="button"
          onClick={() => toggleCamera()}
          disabled={!isConnected}
          className={`vesper-voice-btn ${cameraEnabled ? 'vesper-voice-btn-active' : ''}`}
          title={cameraEnabled ? 'Turn off camera' : 'Turn on camera'}
        >
          {cameraEnabled ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
        </button>

        <button
          type="button"
          onClick={() => toggleScreenShare()}
          disabled={!isConnected}
          className={`vesper-voice-btn ${screenShareEnabled ? 'vesper-voice-btn-active' : ''}`}
          title={screenShareEnabled ? 'Stop sharing' : 'Share screen'}
        >
          {screenShareEnabled ? (
            <ScreenShare className="w-5 h-5" />
          ) : (
            <ScreenShareOff className="w-5 h-5" />
          )}
        </button>

        <button
          type="button"
          onClick={disconnect}
          className="vesper-voice-btn vesper-voice-btn-disconnect"
          title="Disconnect"
        >
          <PhoneOff className="w-5 h-5" />
        </button>
      </div>
    </div>
  )
}
