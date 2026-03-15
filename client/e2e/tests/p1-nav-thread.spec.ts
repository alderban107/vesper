/**
 * P1: Thread context survives refresh.
 * Covers: R-NAV-2
 */

import { test, expect } from '@playwright/test'
import { createUserContext, signup, type UserContext } from '../helpers/auth'
import { createServer, createChannel, getInviteCode, joinServerWithCode, selectServer, selectChannel } from '../helpers/server'
import { sendChannelMessage, openThread, sendThreadReply, getThreadReplies } from '../helpers/channel'
import { hardRefresh } from '../helpers/navigation'
import { waitForMessage, waitForThreadPanel, waitForThreadReplyCount } from '../helpers/wait'
import { USERS } from '../fixtures/test-data'

let alice: UserContext
let bob: UserContext

test.describe('P1: Thread navigation persistence', () => {
  test.beforeAll(async ({ browser }) => {
    alice = await createUserContext(browser, 'alice', USERS.alice.username, USERS.alice.password)
    bob = await createUserContext(browser, 'bob', USERS.bob.username, USERS.bob.password)
    await signup(alice)
    await signup(bob)

    await createServer(alice.page, 'Thread Nav Server')
    const code = await getInviteCode(alice.page)
    await joinServerWithCode(bob.page, code)
    await createChannel(alice.page, 'thread-nav')
    await selectChannel(alice.page, 'thread-nav')
    await selectServer(bob.page, 'Thread Nav Server')
    await selectChannel(bob.page, 'thread-nav')
  })

  test.afterAll(async () => {
    await alice.context.close()
    await bob.context.close()
  })

  test('Thread context survives refresh or is restored clearly (R-NAV-2)', async () => {
    const parentMsg = 'Thread navigation test parent — nav tango'
    const reply1 = 'Thread nav reply 1 — nav uniform'
    const reply2 = 'Thread nav reply 2 — nav victor'

    // Send parent message
    await sendChannelMessage(alice.page, parentMsg)
    await waitForMessage(bob.page, parentMsg)

    // Open thread and add replies
    await openThread(alice.page, parentMsg)
    await sendThreadReply(alice.page, reply1)
    await sendThreadReply(alice.page, reply2)

    // Verify replies are in thread panel
    await waitForThreadPanel(alice.page)
    const repliesBefore = await getThreadReplies(alice.page)
    expect(repliesBefore.length).toBeGreaterThanOrEqual(2)

    // Refresh mid-thread
    await hardRefresh(alice.page)
    await selectServer(alice.page, 'Thread Nav Server')
    await selectChannel(alice.page, 'thread-nav')

    // The product must either:
    // 1. Reopen the thread panel automatically, OR
    // 2. Show thread summary so user can reopen without drift
    const threadPanelAfter = alice.page.locator('[data-testid="thread-panel"]')
    const panelVisible = await threadPanelAfter.isVisible().catch(() => false)

    if (panelVisible) {
      // Thread panel reopened — verify replies are intact
      const repliesAfter = await getThreadReplies(alice.page)
      expect(repliesAfter.length).toBeGreaterThanOrEqual(2)
    } else {
      // Thread panel did not reopen — verify thread count is correct on parent
      const parentRow = alice.page.locator(`[data-testid="message-row"]:has-text("${parentMsg}")`)
      await expect(parentRow).toBeVisible()

      const threadCount = parentRow.locator('[data-testid="thread-count"]')
      const hasCount = await threadCount.isVisible().catch(() => false)
      if (hasCount) {
        const countText = await threadCount.textContent()
        const count = parseInt(countText || '0', 10)
        expect(count).toBeGreaterThanOrEqual(2)
      }

      // Reopen thread and verify replies are still there
      await openThread(alice.page, parentMsg)
      const repliesReopened = await getThreadReplies(alice.page)
      expect(repliesReopened.length).toBeGreaterThanOrEqual(2)
    }
  })
})
