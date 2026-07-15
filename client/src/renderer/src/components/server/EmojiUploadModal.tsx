import { useState } from 'react'
import { X } from 'lucide-react'
import { useServerStore } from '../../stores/serverStore'
import ImageCropModal from '../ui/ImageCropModal'

interface Props {
  file: File
  serverId: string
  onClose: () => void
}

function nameFromFile(file: File): string {
  const raw = file.name.replace(/\.[^.]+$/, '')
  const cleaned = raw
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_~-]/g, '')
    .slice(0, 32)
  return cleaned.length >= 2 ? cleaned : 'emoji'
}

export default function EmojiUploadModal({ file, serverId, onClose }: Props): React.JSX.Element {
  const [name, setName] = useState(() => nameFromFile(file))
  const uploadServerEmoji = useServerStore((s) => s.uploadServerEmoji)

  const validName = /^[a-zA-Z0-9_~-]{2,32}$/.test(name)

  return (
    <ImageCropModal
      file={file}
      title="Add Emoji"
      cropShape="rect"
      aspect={1}
      outputSize={{ width: 128, height: 128 }}
      submitLabel="Finish"
      onSubmit={async (blob) => {
        if (!validName) throw new Error('Invalid emoji name')
        const croppedFile = new File([blob], `${name}.png`, { type: 'image/png' })
        const result = await uploadServerEmoji(serverId, croppedFile, name.trim())
        if (!result) throw new Error('Upload failed')
        onClose()
      }}
      onClose={onClose}
    >
      {/* Emoji name input */}
      <label className="block">
        <span className="text-text-muted text-sm font-medium">
          Emoji name <span className="text-error">*</span>
        </span>
        <div className="relative mt-1">
          <input
            type="text"
            data-testid="emoji-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="emoji_name"
            maxLength={32}
            className="block w-full rounded-lg bg-bg-base/50 border border-border text-text-primary px-3 py-2.5 pr-8 input-focus text-sm"
            autoFocus
          />
          {name && (
            <button
              type="button"
              onClick={() => setName('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        {name && !validName && (
          <span className="text-xs text-error mt-1 block">
            2-32 characters: letters, numbers, _ ~ -
          </span>
        )}
      </label>
    </ImageCropModal>
  )
}
