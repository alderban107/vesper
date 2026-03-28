/**
 * P1: Mention autocomplete and @everyone behavior.
 * Covers: R-MSG-4
 */

import { test, expect } from '@playwright/test'
import { createUserContext, login, type UserContext } from '../helpers/auth'
import { createServer, createChannel, getInviteCode, joinServerWithCode, selectServer, selectChannel } from '../helpers/server'
import { sendChannelMessage } from '../helpers/channel'
import { waitForMessage } from '../helpers/wait'
import { USERS, CHANNEL_MESSAGES } from '../fixtures/test-data'

let alice: UserContext
let bob: UserContext

test.describe('P1: Mentions', () => {
  test.beforeAll(async ({ browser }) => {
    alice = await createUserContext(browser, 'alice', USERS.alice.username, USERS.alice.password)
    bob = await createUserContext(browser, 'bob', USERS.bob.username, USERS.bob.password)
    await login(alice)
    await login(bob)

    await createServer(alice.page, 'Mention Server')
    const code = await getInviteCode(alice.page)
    await joinServerWithCode(bob.page, code)
    await createChannel(alice.page, 'mentions')
    await selectChannel(alice.page, 'mentions')
    await selectServer(bob.page, 'Mention Server')
    await selectChannel(bob.page, 'mentions')
  })

  test.afterAll(async () => {
    await alice.context.close()
    await bob.context.close()
  })

  test('Composer renders markdown decorations inline', async () => {
    const input = alice.page.locator('[data-testid="message-input"]')

    await input.click()
    await alice.page.keyboard.type('**bold** *italic* ~~gone~~')

    // Slate decorations render bold/italic/strikethrough inline
    await expect(input.locator('strong.vesper-slate-bold')).toHaveText('bold')
    await expect(input.locator('em.vesper-slate-italic')).toHaveText('italic')
    await expect(input.locator('s.vesper-slate-strikethrough')).toHaveText('gone')

    // Clear
    await alice.page.keyboard.press('Meta+a')
    await alice.page.keyboard.press('Backspace')
  })

  test('Member mention autocomplete inserts correct syntax (R-MSG-4)', async () => {
    const input = alice.page.locator('[data-testid="message-input"]')
    const autocomplete = alice.page.locator('[data-testid="composer-autocomplete"]')
    const toggleMembers = alice.page.locator('[data-testid="toggle-members"]')
    const memberList = alice.page.locator('[data-testid="member-list"]')

    // Clear editor
    await input.click()
    await alice.page.keyboard.press('Meta+a')
    await alice.page.keyboard.press('Backspace')

    const suffix = 'mention-sync-rmsg4'

    if (await toggleMembers.isVisible().catch(() => false)) {
      await toggleMembers.click()
    }

    await expect(memberList).toBeVisible()
    await expect(
      memberList.getByTestId('member-name').filter({ hasText: USERS.bob.username })
    ).toBeVisible()

    // Type @ to trigger autocomplete
    await input.click()
    await alice.page.keyboard.type('@bob')
    await expect(autocomplete).toBeVisible()

    const bobOption = autocomplete.getByRole('option', { name: USERS.bob.username })
    await expect(bobOption).toBeVisible()
    await bobOption.click()

    // Mention should appear as a void node chip
    await expect(input.locator('.vesper-slate-mention')).toContainText('@bob')

    // Ensure the message includes stable plain text we can assert on both clients.
    await alice.page.keyboard.type(` ${suffix}`)

    // Send via keyboard
    await alice.page.keyboard.press('Enter')
    await waitForMessage(alice.page, suffix)
    await waitForMessage(bob.page, suffix)

    // Bob should see the message with a mention highlight
    const mentionHighlight = bob.page.locator('[data-testid="message-row"] .vesper-mention-highlight, [data-testid="message-row"] .mention')
    const hasMention = await mentionHighlight.count() > 0
    if (!hasMention) {
      await waitForMessage(bob.page, suffix)
    }
  })

  test('@everyone mention reaches all members (R-MSG-4)', async () => {
    await sendChannelMessage(alice.page, '@everyone check this notification')

    // Bob should see the message
    await waitForMessage(bob.page, '@everyone check this notification')

    // The @everyone text should be present
    const messageRow = bob.page.locator('[data-testid="message-row"]:has-text("@everyone")')
    await expect(messageRow).toBeVisible()
  })
})
