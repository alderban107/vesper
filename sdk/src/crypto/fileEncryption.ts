/**
 * AES-256-GCM file encryption for E2EE file sharing.
 * Files are always encrypted client-side before upload.
 * The AES key/IV is embedded in the message content (inside MLS ciphertext when available).
 */

export interface EncryptedFile {
  ciphertext: ArrayBuffer
  key: string // base64-encoded AES key
  iv: string // base64-encoded IV
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

export async function encryptFile(data: ArrayBuffer): Promise<EncryptedFile> {
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  )

  const iv = crypto.getRandomValues(new Uint8Array(12))

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  )

  const exportedKey = await crypto.subtle.exportKey('raw', key)

  return {
    ciphertext,
    key: arrayBufferToBase64(exportedKey),
    iv: arrayBufferToBase64(iv.buffer)
  }
}

export async function decryptFile(
  ciphertext: ArrayBuffer,
  keyBase64: string,
  ivBase64: string
): Promise<ArrayBuffer> {
  const keyData = base64ToArrayBuffer(keyBase64)
  const iv = base64ToArrayBuffer(ivBase64)

  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  )

  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv) },
    key,
    ciphertext
  )
}
