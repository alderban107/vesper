import { apiUpload } from '../api/client'
import { encryptFile } from '../crypto/fileEncryption'
import type { FilePayload } from '../crypto/payload'
import { extractAudioMetadata } from './audioMetadata'
import { extractVideoThumbnail } from './videoThumbnail'

interface UploadedEncryptedAttachment {
  id: string
  iv: string
  key: string
}

export interface PreparedMessageAttachment {
  attachmentIds: string[]
  file: FilePayload['file']
}

async function uploadEncryptedBytes(
  data: ArrayBuffer,
  filename: string
): Promise<UploadedEncryptedAttachment | null> {
  const encrypted = await encryptFile(data)
  const blob = new Blob([encrypted.ciphertext])
  const formData = new FormData()
  formData.append('file', blob, filename)
  formData.append('encrypted', 'true')

  const response = await apiUpload('/api/v1/attachments', formData)
  if (!response.ok) {
    return null
  }

  const payload = await response.json()
  return {
    id: payload.attachment.id,
    iv: encrypted.iv,
    key: encrypted.key
  }
}

async function uploadEncryptedBlob(blob: Blob, filename: string): Promise<UploadedEncryptedAttachment | null> {
  return uploadEncryptedBytes(await blob.arrayBuffer(), filename)
}

export async function prepareMessageAttachment(file: File): Promise<PreparedMessageAttachment | null> {
  const sourceAttachment = await uploadEncryptedBytes(await file.arrayBuffer(), file.name)
  if (!sourceAttachment) {
    return null
  }

  const messageFile: FilePayload['file'] = {
    id: sourceAttachment.id,
    name: file.name,
    content_type: file.type || 'application/octet-stream',
    size: file.size,
    key: sourceAttachment.key,
    iv: sourceAttachment.iv
  }
  const attachmentIds = [sourceAttachment.id]

  if (file.type.startsWith('video/')) {
    try {
      const thumbnail = await extractVideoThumbnail(file)
      if (thumbnail) {
        const uploadedThumbnail = await uploadEncryptedBlob(thumbnail.blob, 'thumbnail.jpg')
        if (uploadedThumbnail) {
          messageFile.thumbnail = {
            id: uploadedThumbnail.id,
            key: uploadedThumbnail.key,
            iv: uploadedThumbnail.iv
          }
          messageFile.duration = thumbnail.duration
          attachmentIds.push(uploadedThumbnail.id)
        }
      }
    } catch {
      // Video uploads still work without thumbnails.
    }
  }

  if (file.type.startsWith('audio/')) {
    try {
      const metadata = await extractAudioMetadata(file)
      if (metadata) {
        if (metadata.duration) {
          messageFile.duration = metadata.duration
        }

        const audioMetadata: NonNullable<FilePayload['file']['audio_metadata']> = {}
        if (metadata.title) audioMetadata.title = metadata.title
        if (metadata.artist) audioMetadata.artist = metadata.artist
        if (metadata.album) audioMetadata.album = metadata.album

        if (metadata.coverBlob) {
          const uploadedCover = await uploadEncryptedBlob(metadata.coverBlob, 'cover.jpg')
          if (uploadedCover) {
            audioMetadata.cover = {
              id: uploadedCover.id,
              key: uploadedCover.key,
              iv: uploadedCover.iv
            }
            attachmentIds.push(uploadedCover.id)
          }
        }

        if (audioMetadata.title || audioMetadata.artist || audioMetadata.album || audioMetadata.cover) {
          messageFile.audio_metadata = audioMetadata
        }
      }
    } catch {
      // Audio uploads still work without extracted metadata.
    }
  }

  return {
    attachmentIds,
    file: messageFile
  }
}
