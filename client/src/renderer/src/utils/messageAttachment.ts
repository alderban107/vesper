import { encryptFile, type FilePayload } from '@vesper/sdk/crypto'
import { extractAudioMetadata } from './audioMetadata'
import { getRendererClient } from '../sdk/client'
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

export class AttachmentPreparationError extends Error {
  readonly hasOrphanedUpload: boolean

  constructor(message: string, options: { hasOrphanedUpload?: boolean } = {}) {
    super(message)
    this.name = 'AttachmentPreparationError'
    this.hasOrphanedUpload = options.hasOrphanedUpload ?? false
  }
}

async function uploadEncryptedBytes(
  data: ArrayBuffer,
  filename: string
): Promise<UploadedEncryptedAttachment> {
  let encrypted: Awaited<ReturnType<typeof encryptFile>>
  try {
    encrypted = await encryptFile(data)
  } catch {
    throw new AttachmentPreparationError('This file could not be encrypted before upload.')
  }

  let formData: FormData
  try {
    formData = new FormData()
    formData.append('file', new Blob([encrypted.ciphertext]), filename)
    formData.append('encrypted', 'true')
  } catch {
    throw new AttachmentPreparationError('This file could not be prepared for upload.')
  }

  let payload
  try {
    payload = await getRendererClient().uploadAttachment(formData)
  } catch {
    throw new AttachmentPreparationError('This file could not be uploaded. Check your connection and try again.')
  }

  if (!payload.attachment?.id) {
    throw new AttachmentPreparationError('The upload did not return a file reference. Try again.')
  }

  return {
    id: payload.attachment.id,
    iv: encrypted.iv,
    key: encrypted.key
  }
}

async function uploadEncryptedBlob(blob: Blob, filename: string): Promise<UploadedEncryptedAttachment> {
  return await uploadEncryptedBytes(await blob.arrayBuffer(), filename)
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
    sourceAttachment = await uploadEncryptedBytes(await file.arrayBuffer(), file.name)
  } catch (error) {
    if (error instanceof AttachmentPreparationError) throw error
    throw new AttachmentPreparationError('This file could not be read before upload.')
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
        uploadedThumbnail = await uploadEncryptedBlob(thumbnail.blob, 'thumbnail.jpg')
      } catch (error) {
        rethrowAfterSourceUpload(error)
      }
      messageFile.thumbnail = {
        id: uploadedThumbnail.id,
        key: uploadedThumbnail.key,
        iv: uploadedThumbnail.iv
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
          uploadedCover = await uploadEncryptedBlob(metadata.coverBlob, 'cover.jpg')
        } catch (error) {
          rethrowAfterSourceUpload(error)
        }
        audioMetadata.cover = {
          id: uploadedCover.id,
          key: uploadedCover.key,
          iv: uploadedCover.iv
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
