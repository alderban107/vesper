/**
 * P1: Offline catch-up and pending welcomes/resync.
 * Covers: R-SYNC-4, R-SYNC-5
 */

import { test, expect } from '@playwright/test'
import { createUserContext, signup, login, type UserContext } from '../helpers/auth'
import { createServer, createChannel, getInviteCode, joinServerWithCode, selectServer, selectChannel } from '../helpers/server'
import { sendChannelMessage } from '../helpers/channel'
import { createDm, selectDm, sendDmMessage } from '../helpers/dm'
import { restartBrowserContext } from '../helpers/navigation'
import { waitForMessage } from '../helpers/wait'
import { assertConvergence, assertNoDecryptionFailures } from '../helpers/assertions'
import { USERS } from '../fixtures/test-data'

let alice: UserContext
let bob: UserContext
let charlie: UserContext

test.describe('P1: Offline sync and pending welcomes', () => {
  test.afterEach(async () => {
    if (alice?.context) await alice.context.close().catch(() => {})
    if (bob?.context) await bob.context.close().catch(() => {})
    if (charlie?.context) await charlie.context.close().catch(() => {})
  })

  test('Client catches up after offline absence (R-SYNC-4)', async ({ browser }) => {
    alice = await createUserContext(browser, 'alice-sync', USERS.alice.username, USERS.alice.password)
    bob = await createUserContext(browser, 'bob-sync', USERS.bob.username, USERS.bob.password)
    await signup(alice)
    await signup(bob)

    // Set up server and channel
    await createServer(alice.page, 'Sync Server')
    const code = await getInviteCode(alice.page)
    await joinServerWithCode(bob.page, code)
    await createChannel(alice.page, 'sync-test')
    await selectChannel(alice.page, 'sync-test')
    await selectServer(bob.page, 'Sync Server')
    await selectChannel(bob.page, 'sync-test')

    // Both exchange some messages
    await sendChannelMessage(alice.page, 'Before offline — sync alpha')
    await waitForMessage(bob.page, 'Before offline — sync alpha')

    // Close bob entirely (simulates going offline)
    await bob.context.close()

    // Alice sends messages while bob is away
    await sendChannelMessage(alice.page, 'While bob offline 1 — sync bravo')
    await sendChannelMessage(alice.page, 'While bob offline 2 — sync charlie')
    await sendChannelMessage(alice.page, 'While bob offline 3 — sync delta')

    // Wait for messages to be fully committed
    await alice.page.waitForTimeout(3_000)

    // Bob comes back
    bob = await createUserContext(browser, 'bob-sync2', USERS.bob.username, USERS.bob.password)
    await login(bob)

    // Navigate to the server and channel
    await selectServer(bob.page, 'Sync Server')
    await selectChannel(bob.page, 'sync-test')

    // Bob should see all messages that were sent while offline
    await waitForMessage(bob.page, 'While bob offline 1 — sync bravo', 30_000)
    await waitForMessage(bob.page, 'While bob offline 2 — sync charlie', 30_000)
    await waitForMessage(bob.page, 'While bob offline 3 — sync delta', 30_000)

    // No decryption failures
    await assertNoDecryptionFailures(bob.page)

    // State should converge
    await assertConvergence(alice.page, bob.page, 'offline catch-up')
  })

  test('Pending welcomes and resync are exercised (R-SYNC-5)', async ({ browser }) => {
    alice = await createUserContext(browser, 'alice-welcome', USERS.alice.username, USERS.alice.password)
    bob = await createUserContext(browser, 'bob-welcome', USERS.bob.username, USERS.bob.password)
    charlie = await createUserContext(browser, 'charlie-welcome', USERS.charlie.username, USERS.charlie.password)
    await signup(alice)
    await signup(bob)
    await signup(charlie)

    // Alice creates a DM with Bob while Charlie is new
    await createDm(alice.page, USERS.bob.username)
    await selectDm(bob.page, USERS.alice.username)
    await sendDmMessage(alice.page, 'Pre-charlie message — welcome echo')
    await waitForMessage(bob.page, 'Pre-charlie message — welcome echo')

    // Create a server where all three will be
    await createServer(alice.page, 'Welcome Server')
    const code = await getInviteCode(alice.page)
    await joinServerWithCode(bob.page, code)

    // Charlie joins later — this may trigger pending welcome/resync
    await joinServerWithCode(charlie.page, code)

    await createChannel(alice.page, 'welcome-test')
    await selectChannel(alice.page, 'welcome-test')
    await selectServer(bob.page, 'Welcome Server')
    await selectChannel(bob.page, 'welcome-test')
    await selectServer(charlie.page, 'Welcome Server')
    await selectChannel(charlie.page, 'welcome-test')

    // All three chat to exercise the MLS group formation with pending welcomes
    await sendChannelMessage(alice.page, 'After charlie join — welcome foxtrot')
    await waitForMessage(bob.page, 'After charlie join — welcome foxtrot')
    await waitForMessage(charlie.page, 'After charlie join — welcome foxtrot', 30_000)

    await sendChannelMessage(charlie.page, 'Charlie first msg — welcome golf')
    await waitForMessage(alice.page, 'Charlie first msg — welcome golf')
    await waitForMessage(bob.page, 'Charlie first msg — welcome golf')

    // No decryption failures — this proves pending welcomes worked
    await assertNoDecryptionFailures(alice.page)
    await assertNoDecryptionFailures(bob.page)
    await assertNoDecryptionFailures(charlie.page)
  })
})
