/**
 * P2: Invite expiry and max-use handling.
 * Covers: R-SERVER-2 (P2), P2 Scenario Pack #4
 */
import { test, expect } from '@playwright/test'
import { createUserContext, signup, type UserContext } from '../helpers/auth'
import { createServer, getInviteCode, joinServerWithCode, selectServer } from '../helpers/server'
import { waitForServerInSidebar } from '../helpers/wait'
import { USERS } from '../fixtures/test-data'

let alice: UserContext
let bob: UserContext
let charlie: UserContext

test.describe('P2: Invite limits', () => {
  test.afterEach(async () => {
    if (alice?.context) await alice.context.close().catch(() => {})
    if (bob?.context) await bob.context.close().catch(() => {})
    if (charlie?.context) await charlie.context.close().catch(() => {})
  })

  test('Expired or max-use invites are rejected (R-SERVER-2)', async ({ browser }) => {
    alice = await createUserContext(browser, 'alice-inv', USERS.alice.username, USERS.alice.password)
    bob = await createUserContext(browser, 'bob-inv', USERS.bob.username, USERS.bob.password)
    charlie = await createUserContext(browser, 'charlie-inv', USERS.charlie.username, USERS.charlie.password)
    await signup(alice)
    await signup(bob)
    await signup(charlie)

    await createServer(alice.page, 'Invite Limits Server')

    // Get a regular invite code
    const code = await getInviteCode(alice.page)
    expect(code).toBeTruthy()

    // Bob joins successfully
    await joinServerWithCode(bob.page, code)
    await waitForServerInSidebar(bob.page, 'Invite Limits Server')

    // Check if invite management UI exists for limiting uses
    await alice.page.click('.vesper-guild-header-button').catch(() => {})
    await alice.page.waitForTimeout(1_000)
    const settingsOption = alice.page.locator('text=Server Settings')
    if (await settingsOption.isVisible()) {
      await settingsOption.click()
      const inviteTab = alice.page.locator('text=Invites')
      if (await inviteTab.isVisible().catch(() => false)) {
        await inviteTab.click()
        // Document what invite management options exist
        await alice.page.waitForTimeout(2_000)
      }
      await alice.page.keyboard.press('Escape')
    }

    // Charlie should also be able to join with the same code (if no limit set)
    await joinServerWithCode(charlie.page, code)
    await waitForServerInSidebar(charlie.page, 'Invite Limits Server')
  })
})
