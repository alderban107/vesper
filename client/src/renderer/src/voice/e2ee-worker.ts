// Web Worker for voice E2EE frame encryption/decryption
// Uses RTCRtpScriptTransform (Insertable Streams) with AES-128-GCM

const IV_LENGTH = 12

let currentKey: CryptoKey | null = null
let previousKey: CryptoKey | null = null
let previousKeyTimeout: ReturnType<typeof setTimeout> | null = null
let frameCounter = 0

interface RTCEncodedFrameLike {
  data: ArrayBuffer
}

async function importKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  )
}

function generateIv(): Uint8Array {
  // 4 bytes counter + 8 bytes random for uniqueness
  const iv = new Uint8Array(IV_LENGTH)
  const counter = frameCounter++
  iv[0] = (counter >> 24) & 0xff
  iv[1] = (counter >> 16) & 0xff
  iv[2] = (counter >> 8) & 0xff
  iv[3] = counter & 0xff
  crypto.getRandomValues(iv.subarray(4))
  return iv
}

async function encryptFrame(
  frame: RTCEncodedFrameLike,
  controller: TransformStreamDefaultController<RTCEncodedFrameLike>
): Promise<void> {
  if (!currentKey) {
    controller.enqueue(frame)
    return
  }

  try {
    const iv = generateIv()
    const data = new Uint8Array(frame.data)

    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      currentKey,
      data
    )

    // Output: [12-byte IV][AES-GCM ciphertext + 16-byte tag]
    const output = new ArrayBuffer(IV_LENGTH + encrypted.byteLength)
    const outputView = new Uint8Array(output)
    outputView.set(iv, 0)
    outputView.set(new Uint8Array(encrypted), IV_LENGTH)

    frame.data = output
    controller.enqueue(frame)
  } catch {
    // If encryption fails, drop the frame
  }
}

async function decryptFrame(
  frame: RTCEncodedFrameLike,
  controller: TransformStreamDefaultController<RTCEncodedFrameLike>
): Promise<void> {
  if (!currentKey) {
    controller.enqueue(frame)
    return
  }

  const data = new Uint8Array(frame.data)
  if (data.byteLength <= IV_LENGTH) {
    // Too small to be encrypted, pass through
    controller.enqueue(frame)
    return
  }

  const iv = data.slice(0, IV_LENGTH)
  const ciphertext = data.slice(IV_LENGTH)

  // Try current key first
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      currentKey,
      ciphertext
    )
    frame.data = decrypted
    controller.enqueue(frame)
    return
  } catch {
    // Current key failed — try previous key during grace period
  }

  // Try previous key (grace period after key rotation)
  if (previousKey) {
    try {
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        previousKey,
        ciphertext
      )
      frame.data = decrypted
      controller.enqueue(frame)
      return
    } catch {
      // Both keys failed — drop frame
    }
  }
}

// Handle RTCRtpScriptTransform events
self.onrtctransform = (event: Event) => {
  const transformer = (event as RTCTransformEvent).transformer
  const readable = transformer.readable
  const writable = transformer.writable
  const options = transformer.options as {
    operation: 'encrypt' | 'decrypt'
    mediaKind?: 'audio' | 'video'
  }

  const transform =
    options.operation === 'encrypt'
      ? encryptFrame
      : decryptFrame

  readable
    .pipeThrough(
      new TransformStream({
        transform: transform as unknown as TransformStreamTransformer<
          RTCEncodedFrameLike,
          RTCEncodedFrameLike
        >['transform']
      })
    )
    .pipeTo(writable)
}

// Handle messages from main thread
self.onmessage = async (event: MessageEvent) => {
  const { type, key } = event.data

  if (type === 'set_key') {
    const rawKey = key as Uint8Array

    // Move current key to previous for grace period
    if (currentKey) {
      previousKey = currentKey
      if (previousKeyTimeout) clearTimeout(previousKeyTimeout)
      previousKeyTimeout = setTimeout(() => {
        previousKey = null
        previousKeyTimeout = null
      }, 2000)
    }

    currentKey = await importKey(rawKey)
    frameCounter = 0
  } else if (type === 'clear') {
    currentKey = null
    previousKey = null
    if (previousKeyTimeout) clearTimeout(previousKeyTimeout)
    previousKeyTimeout = null
  }
}

// TypeScript declarations for RTCRtpScriptTransform APIs
declare global {
  interface RTCTransformEvent extends Event {
    transformer: {
      readable: ReadableStream<RTCEncodedFrameLike>
      writable: WritableStream<RTCEncodedFrameLike>
      options: unknown
    }
  }

  // eslint-disable-next-line no-var
  var onrtctransform: ((event: Event) => void) | null
}

export {}
