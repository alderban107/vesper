import assert from 'node:assert/strict'
import test from 'node:test'

import { createVesperClient } from '../dist/index.js'
import { MemoryStorage } from '../dist/storage/index.js'
import { bootServerStack, teardownServerStack } from '../dist/testing/index.js'
import { createMemorySessionStore } from '../dist/transport/index.js'

function createClientHarness(apiUrl, label) {
  const device = {
    id: `sdk-mls-ordering-${label}-${Math.random().toString(36).slice(2, 10)}`,
    name: `SDK MLS ordering ${label}`,
    platform: 'node'
  }
  const client = createVesperClient({
    baseUrl: apiUrl,
    sessionStore: createMemorySessionStore(apiUrl),
    storage: new MemoryStorage(),
    auth: { getDeviceIdentity: () => device },
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
  let lastError = null

  while (Date.now() < deadline) {
    try {
      const result = await predicate()
      if (result) return result
    } catch (error) {
      lastError = error
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw lastError ?? new Error(`Timed out waiting for ${description}`)
}

test('an offline first-DM recipient recovers the first ciphertext after every sender device disappears', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const sender = createClientHarness(stack.apiUrl, 'sender')
  const recipient = createClientHarness(stack.apiUrl, 'recipient')
  t.after(() => {
    sender.client.stop()
    recipient.client.stop()
  })

  const password = 'sdk-mls-ordering-adversarial-password'
  const suffix = Math.random().toString(36).slice(2, 10)
  const senderSession = await sender.client.register(`ordering_sender_${suffix}`, password)
  const recipientSession = await recipient.client.register(`ordering_recipient_${suffix}`, password)

  // The recipient is truly offline before the conversation, GroupInfo, and
  // first application ciphertext are created.
  recipient.client.stop()

  const conversation = await sender.client.createConversation([recipientSession.user.id])
  assert.ok(conversation.channel_id)

  const scope = { kind: 'channel', id: conversation.channel_id }
  const senderChat = sender.client.createEncryptedChat()
  await senderChat.watchScope(scope)
  assert.equal(await senderChat.ensureScopeReady(scope, true), true)

  const firstText = `first-message-without-live-sender-${suffix}`
  await senderChat.sendText(scope, firstText)
  const sentEpoch = senderChat.getGroupEpoch(scope.id)
  assert.ok(sentEpoch != null && sentEpoch > 0)

  // No sender socket or process remains to answer a late resync/history request.
  sender.client.stop()

  const resumedRecipient = await recipient.client.login(`ordering_recipient_${suffix}`, password)
  assert.equal(resumedRecipient.user.id, recipientSession.user.id)

  const recipientChat = recipient.client.createEncryptedChat()
  await recipientChat.watchScope(scope)
  assert.equal(await recipientChat.ensureMembership(scope), true)

  const recovered = await waitFor('offline recipient first-DM recovery', async () => {
    const synced = await recipientChat.syncScope(scope, { limit: 20 })
    return synced.messages.find((message) => message.content === firstText) ?? null
  })

  assert.equal(recovered.decryptionFailed, false)
  assert.equal(recovered.raw.mls_epoch, sentEpoch)
  assert.equal(recipientChat.isMemberOfGroup(scope.id, senderSession.user.id), true)
  assert.equal(recipientChat.isMemberOfGroup(scope.id, recipientSession.user.id), true)

})
