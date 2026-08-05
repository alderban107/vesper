import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ATTACHMENT_V2_CHUNK_SIZE,
  ATTACHMENT_V2_TAG_SIZE,
  attachmentChunkCount,
  attachmentChunkPlaintextLength,
  attachmentCiphertextSize,
  decryptAttachmentStreamV2,
  encryptAttachmentStreamV2,
  planAttachmentPlaintextRange
} from '../dist/crypto/index.js'

function streamFromBytes(bytes, splits = [bytes.byteLength]) {
  let offset = 0
  let splitIndex = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close()
        return
      }
      const requested = splits[splitIndex % splits.length] ?? bytes.byteLength
      const end = Math.min(bytes.byteLength, offset + requested)
      controller.enqueue(bytes.slice(offset, end))
      offset = end
      splitIndex += 1
    }
  })
}

async function collect(stream) {
  const chunks = []
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

function patternedBytes(length) {
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) bytes[index] = index % 251
  return bytes
}

for (const size of [0, 1, ATTACHMENT_V2_CHUNK_SIZE - 1, ATTACHMENT_V2_CHUNK_SIZE, ATTACHMENT_V2_CHUNK_SIZE + 1, ATTACHMENT_V2_CHUNK_SIZE * 2 + 37]) {
  test(`v2 attachment encryption round-trips ${size} plaintext bytes with irregular source chunks`, async () => {
    const plaintext = patternedBytes(size)
    const encrypted = await encryptAttachmentStreamV2(
      streamFromBytes(plaintext, [1, 31, 65_537, 7, 262_144]),
      plaintext.byteLength
    )
    const ciphertext = await collect(encrypted.ciphertext)

    assert.equal(ciphertext.byteLength, attachmentCiphertextSize(size))
    assert.equal(
      ciphertext.byteLength,
      size + attachmentChunkCount(size) * ATTACHMENT_V2_TAG_SIZE
    )

    const decrypted = await collect(
      decryptAttachmentStreamV2(
        streamFromBytes(ciphertext, [3, 1_111, 131_071]),
        encrypted.encryption,
        size
      )
    )
    assert.deepEqual(decrypted, plaintext)
  })
}

test('v2 attachment framing rejects corruption, truncation, trailing bytes, and false sizes', async () => {
  const plaintext = patternedBytes(ATTACHMENT_V2_CHUNK_SIZE + 19)
  const encrypted = await encryptAttachmentStreamV2(streamFromBytes(plaintext), plaintext.byteLength)
  const ciphertext = await collect(encrypted.ciphertext)

  for (const index of [0, ATTACHMENT_V2_CHUNK_SIZE + ATTACHMENT_V2_TAG_SIZE + 3, ciphertext.byteLength - 1]) {
    const corrupted = ciphertext.slice()
    corrupted[index] ^= 0x80
    await assert.rejects(async () => {
      await collect(decryptAttachmentStreamV2(streamFromBytes(corrupted), encrypted.encryption, plaintext.byteLength))
    })
  }

  await assert.rejects(async () => {
    await collect(
      decryptAttachmentStreamV2(
        streamFromBytes(ciphertext.slice(0, -1)),
        encrypted.encryption,
        plaintext.byteLength
      )
    )
  }, /ended early/)

  const extended = new Uint8Array(ciphertext.byteLength + 1)
  extended.set(ciphertext)
  await assert.rejects(async () => {
    await collect(decryptAttachmentStreamV2(streamFromBytes(extended), encrypted.encryption, plaintext.byteLength))
  }, /trailing bytes/)

  await assert.rejects(async () => {
    await collect(decryptAttachmentStreamV2(streamFromBytes(ciphertext), encrypted.encryption, plaintext.byteLength - 1))
  })
})

test('v2 chunk metadata and plaintext range planning have exact boundary math', () => {
  const size = ATTACHMENT_V2_CHUNK_SIZE * 2 + 25
  assert.equal(attachmentChunkCount(size), 3)
  assert.equal(attachmentChunkPlaintextLength(size, 0), ATTACHMENT_V2_CHUNK_SIZE)
  assert.equal(attachmentChunkPlaintextLength(size, 1), ATTACHMENT_V2_CHUNK_SIZE)
  assert.equal(attachmentChunkPlaintextLength(size, 2), 25)

  const plan = planAttachmentPlaintextRange(
    size,
    ATTACHMENT_V2_CHUNK_SIZE - 4,
    ATTACHMENT_V2_CHUNK_SIZE + 9
  )
  assert.deepEqual(plan, {
    plaintextStart: ATTACHMENT_V2_CHUNK_SIZE - 4,
    plaintextEndExclusive: ATTACHMENT_V2_CHUNK_SIZE + 9,
    plaintextLength: 13,
    firstChunk: 0,
    lastChunk: 1,
    ciphertextStart: 0,
    ciphertextEndExclusive: 2 * (ATTACHMENT_V2_CHUNK_SIZE + ATTACHMENT_V2_TAG_SIZE),
    discardPlaintextPrefix: ATTACHMENT_V2_CHUNK_SIZE - 4
  })

  const final = planAttachmentPlaintextRange(size, size - 10, size)
  assert.equal(final.firstChunk, 2)
  assert.equal(final.lastChunk, 2)
  assert.equal(final.ciphertextStart, 2 * (ATTACHMENT_V2_CHUNK_SIZE + ATTACHMENT_V2_TAG_SIZE))
  assert.equal(final.ciphertextEndExclusive, attachmentCiphertextSize(size))
})

test('v2 encryption validates the declared plaintext length before producing a complete attachment', async () => {
  const short = await encryptAttachmentStreamV2(streamFromBytes(new Uint8Array([1, 2])), 3)
  await assert.rejects(async () => await collect(short.ciphertext), /ended early/)

  const long = await encryptAttachmentStreamV2(streamFromBytes(new Uint8Array([1, 2, 3])), 2)
  await assert.rejects(async () => await collect(long.ciphertext), /trailing bytes/)
})
