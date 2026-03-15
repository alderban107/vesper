/**
 * P1: Message edit and delete convergence.
 * Covers: R-CHANNEL-5
 */

import { test, expect } from '@playwright/test'
import { createUserContext, signup, type UserContext } from '../helpers/auth'
import { createServer, createChannel, getInviteCode, joinServerWithCode, selectServer, selectChannel } from '../helpers/server'
import { sendChannelMessage } from '../helpers/channel'
import { editMessage, deleteMessage } from '../helpers/message'
import { hardRefresh } from '../helpers/navigation'
import { assertConvergence, assertMessageNotVisible, assertMessageVisible } from '../helpers/assertions'
import { USERS, CHANNEL_MESSAGES } from '../fixtures/test-data'

let alice: UserContext
let bob: UserContext

test.describe('P1: Edit and delete', () => {
  test.beforeAll(async ({ browser }) => {
    alice = await createUserContext(browser, 'alice', USERS.alice.username, USERS.alice.password)
    bob = await createUserContext(browser, 'bob', USERS.bob.username, USERS.bob.password)
    await signup(alice)
    await signup(bob)

    // Setup server
    await createServer(alice.page, 'Edit Delete Server')
    const code = await getInviteCode(alice.page)
    await joinServerWithCode(bob.page, code)
    await createChannel(alice.page, 'edit-delete')
    await selectChannel(alice.page, 'edit-delete')
    await selectServer(bob.page, 'Edit Delete Server')
    await selectChannel(bob.page, 'edit-delete')
  })

  test.afterAll(async () => {
    await alice.context.close()
    await bob.context.close()
  })

  test('Edited content replaces old content on every client (R-CHANNEL-5)', async () => {
    await sendChannelMessage(alice.page, CHANNEL_MESSAGES.editOriginal)
    await bob.page.waitForSelector(`[data-testid="message-row"]:has-text("${CHANNEL_MESSAGES.editOriginal}")`, { timeout: 15_000 })

    // Alice edits the message
    await editMessage(alice.page, CHANNEL_MESSAGES.editOriginal, CHANNEL_MESSAGES.editUpdated)

    // Bob should see the edited version
    await bob.page.waitForSelector(
      `[data-testid="message-row"]:has-text("${CHANNEL_MESSAGES.editUpdated}")`,
      { timeout: 15_000 }
    )

    // Old text should be gone
    await assertMessageNotVisible(bob.page, CHANNEL_MESSAGES.editOriginal)

    // Edited marker should appear
    const editedMarker = bob.page.locator('[data-testid="edited-marker"]')
    await expect(editedMarker).toBeVisible()

    // Refresh and verify edit persists
    await hardRefresh(bob.page)
    await selectServer(bob.page, 'Edit Delete Server')
    await selectChannel(bob.page, 'edit-delete')
    await assertMessageVisible(bob.page, CHANNEL_MESSAGES.editUpdated)
  })

  test('Deleted messages disappear on every client (R-CHANNEL-5)', async () => {
    await sendChannelMessage(alice.page, CHANNEL_MESSAGES.deleteTarget)
    await bob.page.waitForSelector(
      `[data-testid="message-row"]:has-text("${CHANNEL_MESSAGES.deleteTarget}")`,
      { timeout: 15_000 }
    )

    // Alice deletes the message
    await deleteMessage(alice.page, CHANNEL_MESSAGES.deleteTarget)

    // Bob should not see it
    await bob.page.waitForSelector(
      `[data-testid="message-row"]:has-text("${CHANNEL_MESSAGES.deleteTarget}")`,
      { state: 'hidden', timeout: 15_000 }
    )

    // Refresh and verify deletion persists
    await hardRefresh(alice.page)
    await selectServer(alice.page, 'Edit Delete Server')
    await selectChannel(alice.page, 'edit-delete')
    await assertMessageNotVisible(alice.page, CHANNEL_MESSAGES.deleteTarget)
  })
})
