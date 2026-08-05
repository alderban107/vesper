import {
  attachmentCiphertextSize,
  assertAttachmentEncryptionV2,
  decryptAttachmentStreamV2,
  decryptFile,
  type AttachmentReference,
  type FileAttachment
} from '@vesper/sdk/crypto'
import { fetchAttachmentBytes, fetchAttachmentResponse } from './attachmentFetch'

const BUFFERED_DOWNLOAD_LIMIT = 8 * 1024 * 1024
const activeAttachmentTransfers = new Set<AbortController>()

function beginAttachmentTransfer(externalSignal?: AbortSignal): {
  signal: AbortSignal
  finish: () => void
} {
  const controller = new AbortController()
  activeAttachmentTransfers.add(controller)
  const signal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal
  return {
    signal,
    finish: () => activeAttachmentTransfers.delete(controller)
  }
}

export function abortActiveAttachmentTransfers(): void {
  for (const controller of activeAttachmentTransfers) {
    controller.abort(new DOMException('Attachment transfer cancelled', 'AbortError'))
  }
  activeAttachmentTransfers.clear()
}

interface SaveFilePickerWindow extends Window {
  showSaveFilePicker?: (options?: {
    suggestedName?: string
    types?: Array<{ description?: string; accept: Record<string, string[]> }>
  }) => Promise<FileSystemFileHandle>
}

type DecryptableReference = AttachmentReference | FileAttachment

export function isStreamableAttachment(
  attachment: DecryptableReference
): attachment is DecryptableReference & { encryption: { v: 2; key: string; nonce_prefix: string } } {
  if (!('encryption' in attachment) || attachment.encryption == null) return false
  assertAttachmentEncryptionV2(attachment.encryption)
  return true
}

function requiredPlaintextSize(attachment: DecryptableReference): number {
  if (typeof attachment.size !== 'number') {
    throw new Error('streamable attachment is missing its plaintext size')
  }
  return attachment.size
}

async function streamablePlaintext(
  attachment: DecryptableReference & { encryption: { v: 2; key: string; nonce_prefix: string } },
  signal?: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
  const plaintextSize = requiredPlaintextSize(attachment)
  const response = await fetchAttachmentResponse(attachment.id, { signal })
  if (response.status !== 200 || !response.body) {
    throw new Error(`attachment stream returned status ${response.status}`)
  }

  const expectedCiphertextSize = attachmentCiphertextSize(plaintextSize)
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && Number.parseInt(declaredLength, 10) !== expectedCiphertextSize) {
    await response.body.cancel('attachment ciphertext size mismatch')
    throw new Error('attachment ciphertext size mismatch')
  }

  return decryptAttachmentStreamV2(response.body, attachment.encryption, plaintextSize)
}

export async function loadDecryptedAttachmentBlob(
  attachment: DecryptableReference,
  contentType: string,
  externalSignal?: AbortSignal
): Promise<Blob> {
  const transfer = beginAttachmentTransfer(externalSignal)
  try {
    if (isStreamableAttachment(attachment)) {
      const plaintext = await streamablePlaintext(attachment, transfer.signal)
      const blob = await new Response(plaintext).blob()
      if (blob.size !== requiredPlaintextSize(attachment)) {
        throw new Error('attachment plaintext size mismatch')
      }
      return new Blob([blob], { type: contentType })
    }

    if (!('key' in attachment) || !('iv' in attachment)) {
      throw new Error('invalid legacy attachment encryption metadata')
    }
    if (transfer.signal.aborted) throw transfer.signal.reason
    const encrypted = await fetchAttachmentBytes(attachment.id)
    if (transfer.signal.aborted) throw transfer.signal.reason
    const decrypted = await decryptFile(encrypted, attachment.key, attachment.iv)
    if (transfer.signal.aborted) throw transfer.signal.reason
    return new Blob([decrypted], { type: contentType })
  } finally {
    transfer.finish()
  }
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function filePickerType(contentType: string, filename: string): Array<{
  description: string
  accept: Record<string, string[]>
}> | undefined {
  const extensionIndex = filename.lastIndexOf('.')
  const extension = extensionIndex >= 0 ? filename.slice(extensionIndex) : ''
  if (!contentType || !extension || !/^\.[A-Za-z0-9]{1,16}$/.test(extension)) return undefined
  return [{ description: contentType, accept: { [contentType]: [extension] } }]
}

export async function saveDecryptedAttachment(
  attachment: FileAttachment,
  contentType: string,
  signal?: AbortSignal
): Promise<void> {
  const picker = (window as SaveFilePickerWindow).showSaveFilePicker

  if (
    isStreamableAttachment(attachment) &&
    attachment.size > BUFFERED_DOWNLOAD_LIMIT &&
    picker
  ) {
    const transfer = beginAttachmentTransfer(signal)
    try {
      const handle = await picker({
        suggestedName: attachment.name,
        types: filePickerType(contentType, attachment.name)
      })
      const writable = await handle.createWritable()

      try {
        await (await streamablePlaintext(attachment, transfer.signal)).pipeTo(writable, {
          signal: transfer.signal
        })
      } catch (error) {
        try {
          await writable.abort(error)
        } catch {
          // pipeTo may already have aborted the atomic temporary write.
        }
        throw error
      }
      return
    } finally {
      transfer.finish()
    }
  }

  if (attachment.size > BUFFERED_DOWNLOAD_LIMIT) {
    throw new Error(
      isStreamableAttachment(attachment)
        ? 'Streaming file saves are unavailable in this browser.'
        : 'This older large attachment cannot be streamed. Ask the sender to resend it.'
    )
  }

  triggerBlobDownload(await loadDecryptedAttachmentBlob(attachment, contentType, signal), attachment.name)
}
