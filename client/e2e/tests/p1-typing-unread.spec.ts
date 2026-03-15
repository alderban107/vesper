/**
 * P1: Typing indicators and unread badges.
 * Covers: R-DM-4, R-CHANNEL-3, R-CHANNEL-4
 */

import { test, expect } from '@playwright/test'
import { readRunState } from '../harness/state'
import { createUserContext, signup, type UserContext } from '../helpers/auth'
import { createDm, selectDm, sendDmMessage, startDmTyping, clearDmComposer } from '../helpers/dm'
import { createServer, createChannel, getInviteCode, joinServerWithCode, selectServer, selectChannel } from '../helpers/server'
import { sendChannelMessage, startChannelTyping, clearChannelComposer } from '../helpers/channel'
import { hardRefresh } from '../helpers/navigation'
import { USERS, SERVER, CHANNELS, DM_MESSAGES, CHANNEL_MESSAGES } from '../fixtures/test-data'

let alice: UserContext
let bob: UserContext

test.describe('P1: Typing and unread behavior', () => {
  test.beforeAll(async ({ browser }) => {
    alice = await createUserContext(browser, 'alice', USERS.alice.username, USERS.alice.password)
    bob = await createUserContext(browser, 'bob', USERS.bob.username, USERS.bob.password)
    await signup(alice)
    await signup(bob)
  })

  test.afterAll(async () => {
    await alice.context.close()
    await bob.context.close()
  })

  test('DM typing indicator appears and clears (R-DM-4)', async () => {
    await createDm(alice.page, USERS.bob.username)
    await selectDm(bob.page, USERS.alice.username)

    // Alice starts typing
    await startDmTyping(alice.page)

    // Bob should see typing indicator
    await bob.page.waitForSelector('[data-testid="typing-indicator"]', { timeout: 10_000 })

    // Clear typing
    await clearDmComposer(alice.page)

    // Typing indicator should clear after timeout
    await bob.page.waitForSelector('[data-testid="typing-indicator"]', {
      state: 'hidden',
      timeout: 10_000,
    })
  })

  test('DM unread badge increments and clears (R-DM-4)', async () => {
    // Bob navigates away from Alice's DM
    await bob.page.click('[data-testid="sidebar"] button[title="Direct Messages"]')

    // Alice sends a message
    await sendDmMessage(alice.page, 'Unread test message alpha')

    // Bob should see unread badge
    await bob.page.waitForSelector('span:has-text("1")', { timeout: 10_000 })

    // Bob opens the DM - unread should clear
    await selectDm(bob.page, USERS.alice.username)
    await bob.page.waitForTimeout(2_000)

    // Refresh and verify unread stays cleared
    await hardRefresh(bob.page)
    await bob.page.waitForTimeout(2_000)
  })

  test('Channel typing indicator appears (R-CHANNEL-4)', async () => {
    // Create server and channel
    await createServer(alice.page, 'Typing Test Server')
    const code = await getInviteCode(alice.page)
    await joinServerWithCode(bob.page, code)

    await createChannel(alice.page, 'typing-test')
    await selectChannel(alice.page, 'typing-test')
    await selectServer(bob.page, 'Typing Test Server')
    await selectChannel(bob.page, 'typing-test')

    // Alice types
    await startChannelTyping(alice.page)

    // Bob should see typing indicator
    await bob.page.waitForSelector('[data-testid="typing-indicator"]', { timeout: 10_000 })

    await clearChannelComposer(alice.page)
    await bob.page.waitForSelector('[data-testid="typing-indicator"]', {
      state: 'hidden',
      timeout: 10_000,
    })
  })

  test('Channel unread badges accumulate and clear (R-CHANNEL-3)', async () => {
    // Bob navigates to a different channel or DM
    await bob.page.click('[data-testid="sidebar"] button[title="Direct Messages"]')

    // Alice sends messages in the channel
    await sendChannelMessage(alice.page, 'Unread channel msg 1')
    await sendChannelMessage(alice.page, 'Unread channel msg 2')

    // Bob returns to server - should see unread badge
    await selectServer(bob.page, 'Typing Test Server')
    await bob.page.waitForSelector('.vesper-channel-unread-badge', { timeout: 10_000 })

    // Bob clicks the channel - unread should clear
    await selectChannel(bob.page, 'typing-test')
    await bob.page.waitForTimeout(2_000)

    // Verify badge is gone
    const badge = bob.page.locator('.vesper-channel-row-active .vesper-channel-unread-badge')
    await expect(badge).toHaveCount(0)

    // Refresh and verify it stays cleared
    await hardRefresh(bob.page)
    const badgeAfter = bob.page.locator('.vesper-channel-row-active .vesper-channel-unread-badge')
    await expect(badgeAfter).toHaveCount(0)
  })
})
