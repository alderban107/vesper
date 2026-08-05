import type { AttachmentEncryptionV2, FilePayload } from '@vesper/sdk/crypto'
import { extractAudioMetadata } from './audioMetadata'
import { getRendererClient } from '../sdk/client'
import { extractVideoThumbnail } from './videoThumbnail'
import { stageEncryptedAttachment } from './attachmentEncryptionStaging'

interface UploadedEncryptedAttachment {
  id: string
  size: number
  encryption: AttachmentEncryptionV2
}

export interface PreparedMessageAttachment {
  attachmentIds: string[]
  file: FilePayload['file']
}

export class AttachmentPreparationError extends Error {
  readonly hasOrphanedUpload: boolean

  constructor(message: string, options: { hasOrphanedUpload?: boolean } = {}) {
    super(message)
    this.name = 'AttachmentPreparationError'
    this.hasOrphanedUpload = options.hasOrphanedUpload ?? false
  }
}

async function uploadEncryptedBlob(
  blob: Blob,
  filename: string,
  contentType = 'application/octet-stream'
): Promise<UploadedEncryptedAttachment> {
  let staged: Awaited<ReturnType<typeof stageEncryptedAttachment>>
  try {
    staged = await stageEncryptedAttachment(blob)
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith('Large encrypted uploads')
      ? error.message
      : 'This file could not be encrypted before upload.'
    throw new AttachmentPreparationError(message)
  }

  try {
    const payload = await getRendererClient().uploadAttachmentBlob(staged.ciphertext, {
      filename,
      contentType
    })

    if (!payload.attachment?.id) {
      throw new AttachmentPreparationError('The upload did not return a file reference. Try again.')
    }

    return {
      id: payload.attachment.id,
      size: blob.size,
      encryption: staged.encryption
    }
  } catch (error) {
    if (error instanceof AttachmentPreparationError) throw error
    throw new AttachmentPreparationError('This file could not be uploaded. Check your connection and try again.')
  } finally {
    await staged.cleanup()
  }
}

function rethrowAfterSourceUpload(error: unknown): never {
  const message = error instanceof Error
    ? error.message
    : 'This file could not be prepared for sending.'
  throw new AttachmentPreparationError(message, { hasOrphanedUpload: true })
}

export async function prepareMessageAttachment(file: File): Promise<PreparedMessageAttachment> {
  let sourceAttachment: UploadedEncryptedAttachment
  try {
    sourceAttachment = await uploadEncryptedBlob(
      file,
      file.name,
      file.type || 'application/octet-stream'
    )
  } catch (error) {
    if (error instanceof AttachmentPreparationError) throw error
    throw new AttachmentPreparationError('This file could not be read before upload.')
  }

  const messageFile: FilePayload['file'] = {
    id: sourceAttachment.id,
    name: file.name,
    content_type: file.type || 'application/octet-stream',
    size: file.size,
    encryption: sourceAttachment.encryption
  }
  const attachmentIds = [sourceAttachment.id]

  if (file.type.startsWith('video/')) {
    let thumbnail
    try {
      thumbnail = await extractVideoThumbnail(file)
    } catch {
      throw new AttachmentPreparationError(
        'A preview could not be created for this video. The file was uploaded but not sent.',
        { hasOrphanedUpload: true }
      )
    }

    if (thumbnail) {
      let uploadedThumbnail: UploadedEncryptedAttachment
      try {
        uploadedThumbnail = await uploadEncryptedBlob(thumbnail.blob, 'thumbnail.jpg', 'image/jpeg')
      } catch (error) {
        rethrowAfterSourceUpload(error)
      }
      messageFile.thumbnail = {
        id: uploadedThumbnail.id,
        size: uploadedThumbnail.size,
        encryption: uploadedThumbnail.encryption
      }
      messageFile.duration = thumbnail.duration
      attachmentIds.push(uploadedThumbnail.id)
    }
  }

  if (file.type.startsWith('audio/')) {
    let metadata
    try {
      metadata = await extractAudioMetadata(file)
    } catch {
      throw new AttachmentPreparationError(
        'Audio details could not be read. The file was uploaded but not sent.',
        { hasOrphanedUpload: true }
      )
    }

    if (metadata) {
      if (metadata.duration) {
        messageFile.duration = metadata.duration
      }

      const audioMetadata: NonNullable<FilePayload['file']['audio_metadata']> = {}
      if (metadata.title) audioMetadata.title = metadata.title
      if (metadata.artist) audioMetadata.artist = metadata.artist
      if (metadata.album) audioMetadata.album = metadata.album

      if (metadata.coverBlob) {
        let uploadedCover: UploadedEncryptedAttachment
        try {
          uploadedCover = await uploadEncryptedBlob(metadata.coverBlob, 'cover.jpg', 'image/jpeg')
        } catch (error) {
          rethrowAfterSourceUpload(error)
        }
        audioMetadata.cover = {
          id: uploadedCover.id,
          size: uploadedCover.size,
          encryption: uploadedCover.encryption
        }
        attachmentIds.push(uploadedCover.id)
      }

      if (audioMetadata.title || audioMetadata.artist || audioMetadata.album || audioMetadata.cover) {
        messageFile.audio_metadata = audioMetadata
      }
    }
  }

  return {
    attachmentIds,
    file: messageFile
  }
}
