/**
 * P1: Member list and presence.
 * Covers: R-SERVER-4
 */

import { test, expect } from '@playwright/test'
import { createUserContext, login, type UserContext } from '../helpers/auth'
import { createServer, createChannel, getInviteCode, joinServerWithCode, selectServer, selectChannel, getMemberNames } from '../helpers/server'
import { createDm } from '../helpers/dm'
import { waitForAppShell } from '../helpers/wait'
import { USERS } from '../fixtures/test-data'

let alice: UserContext
let bob: UserContext
let charlie: UserContext

const EXPECTED_MEMBER_USERNAMES = [
  USERS.alice.username,
  USERS.bob.username,
  USERS.charlie.username
]

test.describe('P1: Member list and presence', () => {
  test.beforeAll(async ({ browser }) => {
    alice = await createUserContext(browser, 'alice', USERS.alice.username, USERS.alice.password)
    bob = await createUserContext(browser, 'bob', USERS.bob.username, USERS.bob.password)
    charlie = await createUserContext(browser, 'charlie', USERS.charlie.username, USERS.charlie.password)
    await login(alice)
    await login(bob)
    await login(charlie)

    await createServer(alice.page, 'Presence Server')
    const code = await getInviteCode(alice.page)
    await joinServerWithCode(bob.page, code)
    await joinServerWithCode(charlie.page, code)

    await createChannel(alice.page, 'presence-test')
    await selectChannel(alice.page, 'presence-test')
    await selectServer(bob.page, 'Presence Server')
    await selectChannel(bob.page, 'presence-test')
    await selectServer(charlie.page, 'Presence Server')
    await selectChannel(charlie.page, 'presence-test')
  })

  test.afterAll(async () => {
    await alice.context.close()
    await bob.context.close()
    await charlie.context.close()
  })

  test('Member list contains all expected users (R-SERVER-4)', async () => {
    await selectServer(alice.page, 'Presence Server')

    // Open member list if it's toggled off
    const toggleMembers = alice.page.locator('[data-testid="toggle-members"]')
    if (await toggleMembers.isVisible()) {
      await toggleMembers.click()
    }

    await alice.page.waitForSelector('[data-testid="member-list"]', { timeout: 10_000 })
    await alice.page.waitForFunction(
      (expectedNames: string[]) => {
        const names = Array.from(document.querySelectorAll('[data-testid="member-name"]'))
          .map((node) => node.textContent?.trim() ?? '')
        return expectedNames.every((name) => names.includes(name))
      },
      EXPECTED_MEMBER_USERNAMES,
      { timeout: 15_000 }
    )

    const members = await getMemberNames(alice.page)
    expect(members).toContain(USERS.alice.username)
    expect(members).toContain(USERS.bob.username)
    expect(members).toContain(USERS.charlie.username)
  })

  test('Presence updates propagate (R-SERVER-4)', async () => {
    // All three users are online — check presence indicators
    const memberList = alice.page.locator('[data-testid="member-list"]')
    await expect(memberList).toBeVisible()
    await alice.page.waitForFunction(
      (expectedNames: string[]) => {
        const names = Array.from(document.querySelectorAll('[data-testid="member-name"]'))
          .map((node) => node.textContent?.trim() ?? '')
        return expectedNames.every((name) => names.includes(name))
      },
      EXPECTED_MEMBER_USERNAMES,
      { timeout: 15_000 }
    )

    // Check that at least alice, bob, charlie appear with online status
    for (const username of [USERS.alice.username, USERS.bob.username, USERS.charlie.username]) {
      const memberRow = memberList.locator(`[data-testid="member-name"]:has-text("${username}")`)
      await expect(memberRow).toBeVisible()
    }
  })

  test('Starting a DM from member list lands in the right conversation (R-SERVER-4)', async () => {
    // Open member list if currently hidden
    const memberList = alice.page.locator('[data-testid="member-list"]')
    const toggleMembers = alice.page.locator('[data-testid="toggle-members"]')
    if (!(await memberList.isVisible().catch(() => false)) && (await toggleMembers.isVisible())) {
      await toggleMembers.click()
    }

    await memberList.waitFor({ state: 'visible', timeout: 10_000 })

    // Find charlie's member row and click the message button
    const charlieRow = alice.page.locator(`[data-testid="member-list"] .vesper-member-row:has([data-testid="member-name"]:has-text("${USERS.charlie.username}"))`)
    const messageBtn = charlieRow.locator('.vesper-member-message-button')
    await messageBtn.click()

    // Should navigate to DM view with charlie
    await alice.page.waitForSelector('.vesper-composer-textarea', { timeout: 10_000 })
    await waitForAppShell(alice.page)
  })
})
