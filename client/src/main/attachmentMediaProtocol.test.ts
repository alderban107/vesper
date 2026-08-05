import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() }
}))

import {
  parseAttachmentMediaRange,
  sliceAttachmentPlaintextStream
} from './attachmentMediaProtocol'

async function collect(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  const values: number[] = []
  for await (const chunk of stream) values.push(...chunk)
  return values
}

describe('attachment media protocol', () => {
  it('maps the byte ranges emitted by Chromium onto plaintext offsets', () => {
    expect(parseAttachmentMediaRange(null, 100)).toBeNull()
    expect(parseAttachmentMediaRange('bytes=0-', 100)).toEqual({ start: 0, endInclusive: 99 })
    expect(parseAttachmentMediaRange('bytes=25-40', 100)).toEqual({ start: 25, endInclusive: 40 })
    expect(parseAttachmentMediaRange('bytes=90-999', 100)).toEqual({ start: 90, endInclusive: 99 })
    expect(parseAttachmentMediaRange('bytes=-10', 100)).toEqual({ start: 90, endInclusive: 99 })
    expect(parseAttachmentMediaRange('bytes=100-', 100)).toBe('invalid')
    expect(parseAttachmentMediaRange('bytes=4-3', 100)).toBe('invalid')
    expect(parseAttachmentMediaRange('bytes=0-1,4-5', 100)).toBe('invalid')
  })

  it('emits only the requested plaintext after complete chunks authenticate', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0, 1, 2, 3]))
        controller.enqueue(new Uint8Array([4, 5, 6]))
        controller.enqueue(new Uint8Array([7, 8, 9]))
        controller.close()
      }
    })

    expect(await collect(sliceAttachmentPlaintextStream(source, 3, 5))).toEqual([3, 4, 5, 6, 7])
  })

  it('drains and authenticates the v2 empty frame before closing an empty response', async () => {
    let consumed = false
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array())
        controller.close()
      },
      cancel() {
        consumed = true
      }
    })

    expect(await collect(sliceAttachmentPlaintextStream(source, 0, 0))).toEqual([])
    expect(consumed).toBe(false)
  })
})
