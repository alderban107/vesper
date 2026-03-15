import { Headphones, HeadphoneOff, LogOut, Mic, MicOff, PhoneOff, ScreenShare, ScreenShareOff, Settings, Video, VideoOff } from 'lucide-react'
import { useVoiceStore } from '../../stores/voiceStore'
import { useServerStore } from '../../stores/serverStore'
import { useDmStore } from '../../stores/dmStore'
import { usePresenceStore, type PresenceStatus } from '../../stores/presenceStore'
import Avatar from '../ui/Avatar'

interface UserLike {
  id: string
  username: string
  display_name: string | null
  avatar_url?: string | null
}

interface Props {
  user: UserLike | null
  logout: () => void
  openSettingsModal: () => void
  onOpenProfile: (event: React.MouseEvent<HTMLButtonElement>) => void
}

const STATUS_COPY: Record<PresenceStatus, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do Not Disturb',
  offline: 'Offline'
}

const STATUS_CLASSES: Record<PresenceStatus, string> = {
  online: 'vesper-account-panel-status-online',
  idle: 'vesper-account-panel-status-idle',
  dnd: 'vesper-account-panel-status-dnd',
  offline: 'vesper-account-panel-status-offline'
}

const VOICE_QUALITY_COPY = {
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  unknown: 'Unknown'
} as const

export default function AccountPanel({
  user,
  logout,
  openSettingsModal,
  onOpenProfile
}: Props): React.JSX.Element {
  const myStatus = usePresenceStore((s) => s.myStatus)
  const setStatus = usePresenceStore((s) => s.setStatus)
  const voiceState = useVoiceStore((s) => s.state)
  const roomId = useVoiceStore((s) => s.roomId)
  const roomType = useVoiceStore((s) => s.roomType)
  const muted = useVoiceStore((s) => s.muted)
  const deafened = useVoiceStore((s) => s.deafened)
  const cameraEnabled = useVoiceStore((s) => s.cameraEnabled)
  const screenShareEnabled = useVoiceStore((s) => s.screenShareEnabled)
  const shareAudioPreferred = useVoiceStore((s) => s.shareAudioPreferred)
  const voiceError = useVoiceStore((s) => s.errorMessage)
  const disconnect = useVoiceStore((s) => s.disconnect)
  const toggleMute = useVoiceStore((s) => s.toggleMute)
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen)
  const toggleCamera = useVoiceStore((s) => s.toggleCamera)
  const toggleScreenShare = useVoiceStore((s) => s.toggleScreenShare)
  const connectionQuality = useVoiceStore((s) => s.connectionQuality)
  const activeServer = useServerStore((s) => s.servers.find((server) => server.id === s.activeServerId))
  const conversations = useDmStore((s) => s.conversations)

  const roomLabel =
    roomType === 'channel'
      ? activeServer?.channels.find((channel) => channel.id === roomId)?.name ?? 'Voice Channel'
      : roomType === 'dm'
        ? conversations.find((conversation) => conversation.id === roomId)?.name ?? 'Direct Call'
        : null

  const voiceStatusCopy =
    voiceError
      ? voiceError
      : voiceState === 'idle'
        ? STATUS_COPY[myStatus]
        : voiceState === 'connecting'
          ? `Joining ${roomLabel ?? 'voice'}`
          : voiceState === 'ringing'
            ? `Calling ${roomLabel ?? 'DM'}`
            : voiceState === 'in_call'
              ? `In call${roomLabel ? ` · ${roomLabel}` : ''}`
              : `Connected${roomLabel ? ` · ${roomLabel}` : ''}`

  const voiceSubcopy =
    voiceState === 'idle' || voiceError
      ? voiceStatusCopy
      : `${voiceStatusCopy} · ${VOICE_QUALITY_COPY[connectionQuality]}`
  const canPublishVideo = voiceState === 'connected' || voiceState === 'in_call'

  const cycleStatus = (): void => {
    const cycle: PresenceStatus[] = ['online', 'idle', 'dnd']
    const currentIndex = cycle.indexOf(myStatus)
    setStatus(cycle[(currentIndex + 1) % cycle.length])
  }

  return (
    <div className="vesper-account-panel">
      <div className="vesper-account-panel-identity-shell">
        <button
          type="button"
          className="vesper-account-panel-identity"
          onClick={onOpenProfile}
        >
          <div className="vesper-account-panel-avatar-wrap">
            <Avatar
              userId={user?.id || 'me'}
              avatarUrl={user?.avatar_url}
              displayName={user?.display_name || user?.username || 'You'}
              size="sm"
            />
          </div>

          <div className="vesper-account-panel-copy">
            <div className="vesper-account-panel-name">
              {user?.display_name || user?.username}
            </div>
            <div className="vesper-account-panel-subcopy">
              {voiceSubcopy}
            </div>
          </div>
        </button>

        <button
          type="button"
          onClick={cycleStatus}
          title={`Status: ${STATUS_COPY[myStatus]}`}
          className={`vesper-account-panel-status ${STATUS_CLASSES[myStatus]}`}
        />
      </div>

      <div className="vesper-account-panel-controls">
        {voiceState !== 'idle' && (
          <>
            <button
              type="button"
              className={`vesper-account-panel-button${muted ? ' vesper-account-panel-button-danger' : ''}`}
              onClick={toggleMute}
              title={muted ? 'Unmute' : 'Mute'}
            >
              {muted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>
            <button
              type="button"
              className={`vesper-account-panel-button${deafened ? ' vesper-account-panel-button-danger' : ''}`}
              onClick={toggleDeafen}
              title={deafened ? 'Undeafen' : 'Deafen'}
            >
              {deafened ? <HeadphoneOff className="w-4 h-4" /> : <Headphones className="w-4 h-4" />}
            </button>
            <button
              type="button"
              className={`vesper-account-panel-button${cameraEnabled ? ' vesper-account-panel-button-active' : ''}${!canPublishVideo ? ' vesper-account-panel-button-disabled' : ''}`}
              onClick={() => {
                void toggleCamera()
              }}
              disabled={!canPublishVideo}
              title={cameraEnabled ? 'Stop Camera' : 'Start Camera'}
            >
              {cameraEnabled ? <VideoOff className="w-4 h-4" /> : <Video className="w-4 h-4" />}
            </button>
            <button
              type="button"
              className={`vesper-account-panel-button${screenShareEnabled ? ' vesper-account-panel-button-active' : ''}${!canPublishVideo ? ' vesper-account-panel-button-disabled' : ''}`}
              onClick={() => {
                void toggleScreenShare(undefined, shareAudioPreferred)
              }}
              disabled={!canPublishVideo}
              title={screenShareEnabled ? 'Stop Screen Share' : 'Start Screen Share'}
            >
              {screenShareEnabled ? <ScreenShareOff className="w-4 h-4" /> : <ScreenShare className="w-4 h-4" />}
            </button>
            <button
              type="button"
              className="vesper-account-panel-button vesper-account-panel-button-danger"
              onClick={disconnect}
              title="Disconnect"
            >
              <PhoneOff className="w-4 h-4" />
            </button>
          </>
        )}
        <button
          type="button"
          className="vesper-account-panel-button"
          onClick={openSettingsModal}
          title="Settings"
        >
          <Settings className="w-4 h-4" />
        </button>
        <button
          type="button"
          className="vesper-account-panel-button"
          onClick={logout}
          title="Logout"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
