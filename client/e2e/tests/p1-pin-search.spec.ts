/**
 * P1: Pin, unpin, jump-to-message, and search.
 * Covers: R-CHANNEL-6, R-MSG-3
 */

import { test, expect } from '@playwright/test'
import { createUserContext, signup, type UserContext } from '../helpers/auth'
import { createServer, createChannel, getInviteCode, joinServerWithCode, selectServer, selectChannel } from '../helpers/server'
import { sendChannelMessage } from '../helpers/channel'
import { pinMessage, unpinMessage, openPinsPanel, getPinnedMessages, jumpToPinnedMessage } from '../helpers/message'
import { searchFor, getSearchResults, clickSearchResult, closeSearch } from '../helpers/search'
import { hardRefresh } from '../helpers/navigation'
import { USERS, CHANNEL_MESSAGES } from '../fixtures/test-data'

let alice: UserContext
let bob: UserContext

test.describe('P1: Pin and search', () => {
  test.beforeAll(async ({ browser }) => {
    alice = await createUserContext(browser, 'alice', USERS.alice.username, USERS.alice.password)
    bob = await createUserContext(browser, 'bob', USERS.bob.username, USERS.bob.password)
    await signup(alice)
    await signup(bob)

    await createServer(alice.page, 'Pin Search Server')
    const code = await getInviteCode(alice.page)
    await joinServerWithCode(bob.page, code)
    await createChannel(alice.page, 'pin-search')
    await selectChannel(alice.page, 'pin-search')
    await selectServer(bob.page, 'Pin Search Server')
    await selectChannel(bob.page, 'pin-search')
  })

  test.afterAll(async () => {
    await alice.context.close()
    await bob.context.close()
  })

  test('Pin, view pinned list, jump to pinned message, unpin (R-CHANNEL-6)', async () => {
    // Send a message to pin
    await sendChannelMessage(alice.page, CHANNEL_MESSAGES.pinTarget)
    await bob.page.waitForSelector(
      `[data-testid="message-row"]:has-text("${CHANNEL_MESSAGES.pinTarget}")`,
      { timeout: 15_000 }
    )

    // Pin the message
    await pinMessage(alice.page, CHANNEL_MESSAGES.pinTarget)

    // Open pins panel
    await openPinsPanel(alice.page)
    const pinned = await getPinnedMessages(alice.page)
    expect(pinned.some((t) => t.includes(CHANNEL_MESSAGES.pinTarget))).toBe(true)

    // Jump to pinned message
    await jumpToPinnedMessage(alice.page, CHANNEL_MESSAGES.pinTarget)

    // Verify pin survives refresh
    await hardRefresh(alice.page)
    await selectServer(alice.page, 'Pin Search Server')
    await selectChannel(alice.page, 'pin-search')
    await openPinsPanel(alice.page)
    const pinnedAfter = await getPinnedMessages(alice.page)
    expect(pinnedAfter.some((t) => t.includes(CHANNEL_MESSAGES.pinTarget))).toBe(true)

    // Unpin
    await unpinMessage(alice.page, CHANNEL_MESSAGES.pinTarget)
    await alice.page.waitForTimeout(1_000)
    await openPinsPanel(alice.page)
    const pinnedFinal = await getPinnedMessages(alice.page)
    expect(pinnedFinal.some((t) => t.includes(CHANNEL_MESSAGES.pinTarget))).toBe(false)
  })

  test('Search finds past messages and jump works (R-MSG-3)', async () => {
    // Send a unique searchable message
    await sendChannelMessage(alice.page, CHANNEL_MESSAGES.searchTarget)
    await bob.page.waitForSelector(
      `[data-testid="message-row"]:has-text("${CHANNEL_MESSAGES.searchTarget}")`,
      { timeout: 15_000 }
    )

    // Search for the unique string
    await searchFor(bob.page, 'xQ7vZ9')
    const results = await getSearchResults(bob.page)
    expect(results.length).toBeGreaterThan(0)
    expect(results.some((r) => r.includes('xQ7vZ9'))).toBe(true)

    // Click the result to jump
    await clickSearchResult(bob.page, 'xQ7vZ9')
    await closeSearch(bob.page)

    // The target message should be visible
    await expect(
      bob.page.locator(`[data-testid="message-row"]:has-text("${CHANNEL_MESSAGES.searchTarget}")`)
    ).toBeVisible()
  })
})
