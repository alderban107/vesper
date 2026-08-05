import assert from 'node:assert/strict'
import test from 'node:test'

import { createVesperClient } from '../dist/index.js'
import {
  decryptAttachmentStreamV2,
  decryptFile,
  encryptAttachmentStreamV2,
  encryptFile
} from '../dist/crypto/index.js'
import { MemoryStorage } from '../dist/storage/index.js'
import { bootServerStack, teardownServerStack } from '../dist/testing/index.js'
import { createMemorySessionStore } from '../dist/transport/index.js'

function createClientHarness(apiUrl, label) {
  const device = {
    id: `sdk-attachment-${label}-${Math.random().toString(36).slice(2, 10)}`,
    name: `SDK attachment ${label}`,
    platform: 'node'
  }
  const client = createVesperClient({
    baseUrl: apiUrl,
    sessionStore: createMemorySessionStore(apiUrl),
    storage: new MemoryStorage(),
    auth: {
      getDeviceIdentity: () => device
    },
    socketOptions: {
      logger: {
        error: () => {},
        log: () => {}
      }
    }
  })

  return { client, device }
}

async function waitFor(description, predicate, timeoutMs = 15_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function collectStream(stream) {
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    chunks.push(chunk)
    size += chunk.byteLength
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

test('first DM attachment converges on one MLS group and decrypts for the recipient', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const alice = createClientHarness(stack.apiUrl, 'alice')
  const bob = createClientHarness(stack.apiUrl, 'bob')
  t.after(() => {
    alice.client.stop()
    bob.client.stop()
  })

  const password = 'sdk-attachment-password'
  const suffix = Math.random().toString(36).slice(2, 10)
  const aliceSession = await alice.client.register(`att_alice_${suffix}`, password)
  const bobSession = await bob.client.register(`att_bob_${suffix}`, password)
  const conversation = await alice.client.createConversation([bobSession.user.id])
  assert.ok(conversation.channel_id)

  await waitFor('recipient conversation visibility', async () => {
    const conversations = await bob.client.listConversations()
    return conversations.some((entry) => entry.id === conversation.id)
  })

  const scope = { kind: 'channel', id: conversation.channel_id }
  const aliceChat = alice.client.createEncryptedChat()
  const bobChat = bob.client.createEncryptedChat()
  await Promise.all([aliceChat.watchScope(scope), bobChat.watchScope(scope)])
  await Promise.all([
    aliceChat.prepareScopeForRead(scope, { reason: 'attachment_regression' }),
    bobChat.prepareScopeForRead(scope, { reason: 'attachment_regression' })
  ])

  await waitFor('DM MLS convergence', async () => {
    const aliceEpoch = aliceChat.getGroupEpoch(scope.id)
    const bobEpoch = bobChat.getGroupEpoch(scope.id)
    return aliceEpoch != null && aliceEpoch > 0 && aliceEpoch === bobEpoch
  })

  assert.equal(aliceChat.isMemberOfGroup(scope.id, aliceSession.user.id), true)
  assert.equal(aliceChat.isMemberOfGroup(scope.id, bobSession.user.id), true)
  assert.equal(bobChat.isMemberOfGroup(scope.id, aliceSession.user.id), true)
  assert.equal(bobChat.isMemberOfGroup(scope.id, bobSession.user.id), true)

  const plaintext = new TextEncoder().encode('first DM attachment payload')
  const encrypted = await encryptAttachmentStreamV2(
    new Blob([plaintext]).stream(),
    plaintext.byteLength
  )
  const ciphertext = await collectStream(encrypted.ciphertext)
  const uploaded = await alice.client.uploadAttachmentBlob(
    new Blob([ciphertext]),
    { filename: 'first-dm-attachment.txt', contentType: 'text/plain' }
  )
  const attachmentId = uploaded.attachment?.id
  assert.ok(attachmentId)

  await aliceChat.sendPayload(
    scope,
    {
      v: 1,
      type: 'file',
      text: null,
      file: {
        id: attachmentId,
        name: 'first-dm-attachment.txt',
        content_type: 'text/plain',
        size: plaintext.byteLength,
        encryption: encrypted.encryption
      }
    },
    { attachmentIds: [attachmentId] }
  )

  const received = await waitFor('recipient attachment decryption', async () => {
    const synced = await bobChat.syncScope(scope, { limit: 10 })
    return synced.messages.find((message) => {
      if (message.decryptionFailed || !message.plaintext) return false
      const payload = JSON.parse(message.plaintext)
      return payload.type === 'file' && payload.file?.id === attachmentId
    }) ?? null
  })
  assert.equal(received.raw.attachments?.[0]?.id, attachmentId)
  assert.equal(received.raw.sender_id, aliceSession.user.id)

  const downloaded = await bob.client.fetchAttachmentResponse(attachmentId)
  assert.ok(downloaded.body)
  const decrypted = await collectStream(
    decryptAttachmentStreamV2(downloaded.body, encrypted.encryption, plaintext.byteLength)
  )
  assert.equal(new TextDecoder().decode(decrypted), 'first DM attachment payload')
})

test('an offline DM recipient does not block the other participant from sending first', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const first = createClientHarness(stack.apiUrl, 'offline-first')
  const second = createClientHarness(stack.apiUrl, 'offline-second')
  t.after(() => {
    first.client.stop()
    second.client.stop()
  })

  const password = 'sdk-attachment-offline-password'
  const suffix = Math.random().toString(36).slice(2, 10)
  const firstSession = await first.client.register(`off_first_${suffix}`, password)
  const secondSession = await second.client.register(`off_second_${suffix}`, password)
  const [sender, recipient] = firstSession.user.id.localeCompare(secondSession.user.id) > 0
    ? [{ ...first, session: firstSession }, { ...second, session: secondSession }]
    : [{ ...second, session: secondSession }, { ...first, session: firstSession }]

  const conversation = await sender.client.createConversation([recipient.session.user.id])
  assert.ok(conversation.channel_id)
  await waitFor('offline recipient conversation visibility', async () => {
    const conversations = await recipient.client.listConversations()
    return conversations.some((entry) => entry.id === conversation.id)
  })

  const scope = { kind: 'channel', id: conversation.channel_id }
  const senderChat = sender.client.createEncryptedChat()
  await senderChat.watchScope(scope)
  assert.equal(await senderChat.ensureScopeReady(scope, true), true)

  const plaintext = new TextEncoder().encode('offline recipient attachment payload')
  const encrypted = await encryptFile(plaintext.buffer)
  const formData = new FormData()
  formData.append('file', new Blob([encrypted.ciphertext]), 'offline-recipient.txt')
  formData.append('encrypted', 'true')
  const uploaded = await sender.client.uploadAttachment(formData)
  const attachmentId = uploaded.attachment?.id
  assert.ok(attachmentId)

  await senderChat.sendPayload(
    scope,
    {
      v: 1,
      type: 'file',
      text: null,
      file: {
        id: attachmentId,
        name: 'offline-recipient.txt',
        content_type: 'text/plain',
        size: plaintext.byteLength,
        key: encrypted.key,
        iv: encrypted.iv
      }
    },
    { attachmentIds: [attachmentId] }
  )

  const recipientChat = recipient.client.createEncryptedChat()
  await recipientChat.watchScope(scope)
  await waitFor('offline recipient to join the sender group', async () => {
    return await recipientChat.ensureMembership(scope)
  })

  const received = await waitFor('offline recipient attachment recovery', async () => {
    const synced = await recipientChat.syncScope(scope, { limit: 10 })
    return synced.messages.find((message) => {
      if (message.decryptionFailed || !message.plaintext) return false
      const payload = JSON.parse(message.plaintext)
      return payload.type === 'file' && payload.file?.id === attachmentId
    }) ?? null
  })
  assert.equal(received.raw.sender_id, sender.session.user.id)

  const downloaded = await recipient.client.fetchAttachmentBytes(attachmentId)
  const decrypted = await decryptFile(downloaded, encrypted.key, encrypted.iv)
  assert.equal(new TextDecoder().decode(decrypted), 'offline recipient attachment payload')
})
