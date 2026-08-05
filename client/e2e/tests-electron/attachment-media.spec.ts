import { createServer, type Server } from 'node:http'
import { resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of stream) {
    chunks.push(chunk)
    length += chunk.byteLength
  }
  const output = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind TCP')
  return address.port
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

function createPcmWav(durationSeconds: number): Uint8Array {
  const sampleRate = 48_000
  const channels = 2
  const bytesPerSample = 2
  const dataLength = durationSeconds * sampleRate * channels * bytesPerSample
  const bytes = new Uint8Array(44 + dataLength)
  const view = new DataView(bytes.buffer)
  const writeAscii = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index)
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, bytesPerSample * 8, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataLength, true)
  return bytes
}

test('custom media protocol authenticates and serves requested plaintext ranges', async () => {
  const { encryptAttachmentStreamV2 } = await import('../../../sdk/dist/crypto/index.js')
  const plaintext = createPcmWav(12)
  const encrypted = await encryptAttachmentStreamV2(new Blob([plaintext]).stream(), plaintext.length)
  const ciphertext = await collect(encrypted.ciphertext)
  const ciphertextBuffer = Buffer.from(ciphertext)
  const attachmentId = '00000000-0000-4000-8000-000000000101'

  const server = createServer((request, response) => {
    if (
      request.url !== `/api/v1/attachments/${attachmentId}` ||
      request.headers.authorization !== 'Bearer electron-media-token'
    ) {
      response.writeHead(403).end()
      return
    }

    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
    if (!match) {
      response.writeHead(416, { 'content-range': `bytes */${ciphertextBuffer.length}` }).end()
      return
    }
    const start = Number.parseInt(match[1]!, 10)
    const end = Math.min(Number.parseInt(match[2]!, 10), ciphertextBuffer.length - 1)
    const body = ciphertextBuffer.subarray(start, end + 1)
    response.writeHead(206, {
      'accept-ranges': 'bytes',
      'content-type': 'application/octet-stream',
      'content-length': body.length,
      'content-range': `bytes ${start}-${end}/${ciphertextBuffer.length}`
    })
    response.end(body)
  })
  const port = await listen(server)

  const app = await electron.launch({
    args: [resolve(__dirname, '../../out/main/index.js')],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    }
  })

  try {
    const page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as unknown as { attachmentMedia?: unknown }).attachmentMedia))

    const mediaUrl = await page.evaluate(async (registration) => {
      const api = (window as unknown as {
        attachmentMedia: { register(value: typeof registration): Promise<string> }
      }).attachmentMedia
      return await api.register(registration)
    }, {
      attachmentId,
      serverUrl: `http://127.0.0.1:${port}`,
      accessToken: 'electron-media-token',
      contentType: 'audio/wav',
      plaintextSize: plaintext.length,
      encryption: encrypted.encryption
    })

    const start = 1024 * 1024 - 7
    const end = 1024 * 1024 + 19
    const result = await page.evaluate(async ({ mediaUrl, start, end }) => {
      const response = await fetch(mediaUrl, {
        headers: { Range: `bytes=${start}-${end}` }
      })
      return {
        status: response.status,
        contentRange: response.headers.get('content-range'),
        bytes: Array.from(new Uint8Array(await response.arrayBuffer()))
      }
    }, { mediaUrl, start, end })

    expect(result.status).toBe(206)
    expect(result.contentRange).toBe(`bytes ${start}-${end}/${plaintext.length}`)
    expect(result.bytes).toEqual(Array.from(plaintext.subarray(start, end + 1)))

    const playback = await page.evaluate(async (url) => {
      const audio = document.createElement('audio')
      audio.preload = 'metadata'
      audio.src = url
      document.body.append(audio)
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(() => reject(new Error('media metadata timeout')), 10_000)
          audio.addEventListener('loadedmetadata', () => {
            window.clearTimeout(timeout)
            resolve()
          }, { once: true })
          audio.addEventListener('error', () => reject(new Error('media element rejected stream')), {
            once: true
          })
          audio.load()
        })
        audio.currentTime = 8
        await new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(() => reject(new Error('media seek timeout')), 10_000)
          audio.addEventListener('seeked', () => {
            window.clearTimeout(timeout)
            resolve()
          }, { once: true })
        })
        return { duration: audio.duration, currentTime: audio.currentTime }
      } finally {
        audio.remove()
      }
    }, mediaUrl)

    expect(playback.duration).toBeCloseTo(12, 1)
    expect(playback.currentTime).toBeCloseTo(8, 1)
  } finally {
    await app.close()
    await closeServer(server)
  }
})
