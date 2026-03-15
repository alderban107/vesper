/**
 * P1: Custom emoji in message bodies and as reactions.
 * Covers: R-EMOJI-2
 */

import { test, expect } from '@playwright/test'
import { createUserContext, signup, type UserContext } from '../helpers/auth'
import { createServer, createChannel, getInviteCode, joinServerWithCode, selectServer, selectChannel } from '../helpers/server'
import { sendChannelMessage } from '../helpers/channel'
import { uploadCustomEmoji, useCustomEmojiInMessage, reactWithCustomEmoji, isCustomEmojiRendered } from '../helpers/emoji'
import { getReactions } from '../helpers/message'
import { waitForMessage } from '../helpers/wait'
import { hardRefresh } from '../helpers/navigation'
import { USERS, CUSTOM_EMOJI, CHANNEL_MESSAGES } from '../fixtures/test-data'

let alice: UserContext
let bob: UserContext

test.describe('P1: Custom emoji in messages and reactions', () => {
  test.beforeAll(async ({ browser }) => {
    alice = await createUserContext(browser, 'alice', USERS.alice.username, USERS.alice.password)
    bob = await createUserContext(browser, 'bob', USERS.bob.username, USERS.bob.password)
    await signup(alice)
    await signup(bob)

    await createServer(alice.page, 'Emoji Server')
    const code = await getInviteCode(alice.page)
    await joinServerWithCode(bob.page, code)

    // Upload custom emoji
    await uploadCustomEmoji(alice.page, CUSTOM_EMOJI.name, CUSTOM_EMOJI.base64)

    await createChannel(alice.page, 'emoji-test')
    await selectChannel(alice.page, 'emoji-test')
    await selectServer(bob.page, 'Emoji Server')
    await selectChannel(bob.page, 'emoji-test')
  })

  test.afterAll(async () => {
    await alice.context.close()
    await bob.context.close()
  })

  test('Custom emoji renders in message body (R-EMOJI-2)', async () => {
    // Send a message with :testfire: inline
    await sendChannelMessage(alice.page, CHANNEL_MESSAGES.emojiInBody)

    // Wait for message on bob's side
    await waitForMessage(bob.page, CHANNEL_MESSAGES.emojiInBody)

    // Emoji should render as an image, not raw :testfire: text
    const aliceRendered = await isCustomEmojiRendered(alice.page, CUSTOM_EMOJI.name)
    const bobRendered = await isCustomEmojiRendered(bob.page, CUSTOM_EMOJI.name)

    expect(aliceRendered).toBe(true)
    expect(bobRendered).toBe(true)

    // Verify rendering survives refresh
    await hardRefresh(bob.page)
    await selectServer(bob.page, 'Emoji Server')
    await selectChannel(bob.page, 'emoji-test')
    const afterRefresh = await isCustomEmojiRendered(bob.page, CUSTOM_EMOJI.name)
    expect(afterRefresh).toBe(true)
  })

  test('Custom emoji works as a reaction (R-EMOJI-2)', async () => {
    // Send a target message
    const reactionTarget = 'React with custom emoji target — emoji test sierra'
    await sendChannelMessage(alice.page, reactionTarget)
    await waitForMessage(bob.page, reactionTarget)

    // React with custom emoji
    await reactWithCustomEmoji(alice.page, reactionTarget, CUSTOM_EMOJI.name)

    // Bob should see the custom emoji reaction
    await bob.page.waitForSelector('[data-testid="reaction-chip"]', { timeout: 10_000 })

    // Verify the custom emoji is rendered in the reaction chip
    const reactionChip = bob.page.locator(
      `[data-testid="message-row"]:has-text("${reactionTarget}") [data-testid="reaction-chip"]`
    )
    await expect(reactionChip).toBeVisible()

    // The reaction chip should contain an emoji image or data attribute
    const hasEmojiImage = await reactionChip.locator(
      `img[alt=":${CUSTOM_EMOJI.name}:"], [data-emoji-name="${CUSTOM_EMOJI.name}"]`
    ).count() > 0
    expect(hasEmojiImage).toBe(true)
  })
})
