/** Version 1 structured message payload — encrypted as JSON inside MLS ciphertext */

export interface TextPayload {
  v: 1
  type: 'text'
  text: string
}

export interface FilePayload {
  v: 1
  type: 'file'
  text: string | null // optional caption
  file: {
    id: string // server-side attachment ID
    name: string
    content_type: string
    size: number
    key: string // base64-encoded AES-256-GCM key
    iv: string // base64-encoded IV
  }
}

export type MessagePayload = TextPayload | FilePayload

/** Encode a payload to the string that will be MLS-encrypted */
export function encodePayload(payload: MessagePayload): string {
  return JSON.stringify(payload)
}

/**
 * Decode a payload from the decrypted MLS plaintext.
 * Handles backward compat:
 *  - v1 payloads (have `v` field) are returned as-is
 *  - v0 legacy JSON file envelopes (have `type: 'file'` but no `v`) are upgraded to v1
 *  - bare strings (not JSON) are wrapped as TextPayload
 */
export function decodePayload(plaintext: string): MessagePayload {
  try {
    const parsed = JSON.parse(plaintext)
    if (parsed && typeof parsed === 'object') {
      // v1 payload — already has version tag
      if ('v' in parsed && parsed.v === 1) {
        return parsed as MessagePayload
      }
      // v0 legacy file envelope (no version field, but has type: 'file' + file object)
      if (parsed.type === 'file' && parsed.file) {
        return {
          v: 1,
          type: 'file',
          text: parsed.text ?? null,
          file: parsed.file
        } as FilePayload
      }
    }
  } catch {
    // Not JSON — legacy bare string
  }
  // Legacy v0: wrap bare string as text payload
  return { v: 1, type: 'text', text: plaintext }
}

/** Extract display text from any payload type */
export function getDisplayText(payload: MessagePayload): string {
  switch (payload.type) {
    case 'text':
      return payload.text
    case 'file':
      return payload.text ?? `📎 ${payload.file.name}`
    default:
      return '[Unsupported message type]'
  }
}
