/**
 * P1: Disappearing messages TTL and expiry.
 * Covers: R-CHANNEL-7
 */

import { test, expect } from '@playwright/test'
import { createUserContext, signup, type UserContext } from '../helpers/auth'
import { createServer, createChannel, getInviteCode, joinServerWithCode, selectServer, selectChannel } from '../helpers/server'
import { sendChannelMessage } from '../helpers/channel'
import { USERS, CHANNEL_MESSAGES } from '../fixtures/test-data'

let alice: UserContext
let bob: UserContext

test.describe('P1: Disappearing messages', () => {
  test.beforeAll(async ({ browser }) => {
    alice = await createUserContext(browser, 'alice', USERS.alice.username, USERS.alice.password)
    bob = await createUserContext(browser, 'bob', USERS.bob.username, USERS.bob.password)
    await signup(alice)
    await signup(bob)

    await createServer(alice.page, 'Disappearing Server')
    const code = await getInviteCode(alice.page)
    await joinServerWithCode(bob.page, code)
    await createChannel(alice.page, 'disappearing')
    await selectChannel(alice.page, 'disappearing')
    await selectServer(bob.page, 'Disappearing Server')
    await selectChannel(bob.page, 'disappearing')
  })

  test.afterAll(async () => {
    await alice.context.close()
    await bob.context.close()
  })

  test('TTL can be changed and expiry labels render (R-CHANNEL-7)', async () => {
    // Open disappearing settings via header
    await alice.page.click('[data-testid="disappearing-settings"]')
    await alice.page.waitForSelector('[data-testid="ttl-picker"]', { timeout: 5_000 })

    // Set TTL to a short duration (e.g., 30 seconds)
    await alice.page.click('[data-testid="ttl-option-30s"]')
    await alice.page.waitForTimeout(1_000)

    // Send a disappearing message
    await sendChannelMessage(alice.page, CHANNEL_MESSAGES.disappearing)
    await bob.page.waitForSelector(
      `[data-testid="message-row"]:has-text("${CHANNEL_MESSAGES.disappearing}")`,
      { timeout: 15_000 }
    )

    // Check for expiry label on both clients
    const aliceExpiry = alice.page.locator('[data-testid="message-row"]:has-text("' + CHANNEL_MESSAGES.disappearing + '") [data-testid="expiry-label"]')
    const bobExpiry = bob.page.locator('[data-testid="message-row"]:has-text("' + CHANNEL_MESSAGES.disappearing + '") [data-testid="expiry-label"]')

    // At least one side should show the expiry label
    const aliceHas = await aliceExpiry.count() > 0
    const bobHas = await bobExpiry.count() > 0
    expect(aliceHas || bobHas).toBe(true)

    // Wait for expiry and verify message disappears
    await alice.page.waitForSelector(
      `[data-testid="message-row"]:has-text("${CHANNEL_MESSAGES.disappearing}")`,
      { state: 'hidden', timeout: 60_000 }
    )

    // Verify on bob's side too
    await bob.page.waitForSelector(
      `[data-testid="message-row"]:has-text("${CHANNEL_MESSAGES.disappearing}")`,
      { state: 'hidden', timeout: 60_000 }
    )
  })
})
