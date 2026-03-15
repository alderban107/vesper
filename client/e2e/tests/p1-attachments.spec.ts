/**
 * P1: File attachments, image previews, audio previews.
 * Covers: R-DM-5, R-MSG-1, R-MSG-2
 */

import { test, expect } from '@playwright/test'
import path from 'path'
import { createUserContext, signup, type UserContext } from '../helpers/auth'
import { createDm, selectDm, uploadDmAttachment } from '../helpers/dm'
import { createServer, createChannel, getInviteCode, joinServerWithCode, selectServer, selectChannel } from '../helpers/server'
import { uploadChannelAttachment } from '../helpers/channel'
import { hardRefresh } from '../helpers/navigation'
import { assertNoDecryptionFailures } from '../helpers/assertions'
import { USERS } from '../fixtures/test-data'

const ATTACHMENT_PATH = path.resolve(__dirname, '..', 'fixtures', 'test-attachment.txt')

let alice: UserContext
let bob: UserContext

test.describe('P1: Attachments', () => {
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

  test('DM attachment uploads, decrypts, and survives reload (R-DM-5, R-MSG-1)', async () => {
    await createDm(alice.page, USERS.bob.username)
    await selectDm(bob.page, USERS.alice.username)

    // Upload file in DM
    await uploadDmAttachment(alice.page, ATTACHMENT_PATH)

    // Wait for attachment to appear on both sides
    await alice.page.waitForSelector('[data-testid="attachment"]', { timeout: 30_000 })
    await bob.page.waitForSelector('[data-testid="attachment"]', { timeout: 30_000 })

    // Verify attachment name is visible
    await expect(alice.page.locator('[data-testid="attachment"]')).toContainText('test-attachment')
    await expect(bob.page.locator('[data-testid="attachment"]')).toContainText('test-attachment')

    // No decryption failures
    await assertNoDecryptionFailures(alice.page)
    await assertNoDecryptionFailures(bob.page)

    // Reload and verify it survives (R-MSG-2)
    await hardRefresh(alice.page)
    await selectDm(alice.page, USERS.bob.username)
    await alice.page.waitForSelector('[data-testid="attachment"]', { timeout: 30_000 })
    await assertNoDecryptionFailures(alice.page)

    // Verify no "File expired or unavailable"
    const expired = await alice.page.locator('text=File expired or unavailable').count()
    expect(expired).toBe(0)
  })

  test('Channel attachment uploads and decrypts (R-MSG-1)', async () => {
    await createServer(alice.page, 'Attachment Server')
    const code = await getInviteCode(alice.page)
    await joinServerWithCode(bob.page, code)

    await createChannel(alice.page, 'files')
    await selectChannel(alice.page, 'files')
    await selectServer(bob.page, 'Attachment Server')
    await selectChannel(bob.page, 'files')

    // Upload in channel
    await uploadChannelAttachment(alice.page, ATTACHMENT_PATH)

    // Wait for attachment on both sides
    await alice.page.waitForSelector('[data-testid="attachment"]', { timeout: 30_000 })
    await bob.page.waitForSelector('[data-testid="attachment"]', { timeout: 30_000 })

    await assertNoDecryptionFailures(alice.page)
    await assertNoDecryptionFailures(bob.page)

    // Reload and verify preview still loads (R-MSG-2)
    await hardRefresh(bob.page)
    await selectServer(bob.page, 'Attachment Server')
    await selectChannel(bob.page, 'files')
    await bob.page.waitForSelector('[data-testid="attachment"]', { timeout: 30_000 })
    await assertNoDecryptionFailures(bob.page)
  })
})
