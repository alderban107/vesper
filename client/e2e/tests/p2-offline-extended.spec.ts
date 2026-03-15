/**
 * P2: Extended offline catch-up scenarios.
 * Covers: R-SYNC-4 (extended), P2 Scenario Pack #2
 */
import { test, expect } from '@playwright/test'
import { createUserContext, signup, login, type UserContext } from '../helpers/auth'
import { createServer, createChannel, getInviteCode, joinServerWithCode, selectServer, selectChannel } from '../helpers/server'
import { sendChannelMessage } from '../helpers/channel'
import { createDm, selectDm, sendDmMessage } from '../helpers/dm'
import { waitForMessage } from '../helpers/wait'
import { assertConvergence, assertNoDecryptionFailures } from '../helpers/assertions'
import { USERS } from '../fixtures/test-data'

let alice: UserContext
let bob: UserContext

test.describe('P2: Extended offline catch-up', () => {
  test.afterEach(async () => {
    if (alice?.context) await alice.context.close().catch(() => {})
    if (bob?.context) await bob.context.close().catch(() => {})
  })

  test('Client catches up after extended absence with many messages (R-SYNC-4)', async ({ browser }) => {
    alice = await createUserContext(browser, 'alice-ext', USERS.alice.username, USERS.alice.password)
    bob = await createUserContext(browser, 'bob-ext', USERS.bob.username, USERS.bob.password)
    await signup(alice)
    await signup(bob)

    await createServer(alice.page, 'Extended Offline Server')
    const code = await getInviteCode(alice.page)
    await joinServerWithCode(bob.page, code)
    await createChannel(alice.page, 'offline-ext')
    await selectChannel(alice.page, 'offline-ext')
    await selectServer(bob.page, 'Extended Offline Server')
    await selectChannel(bob.page, 'offline-ext')

    // Exchange initial messages
    await sendChannelMessage(alice.page, 'Before offline — ext alpha')
    await waitForMessage(bob.page, 'Before offline — ext alpha')

    // Close bob for extended time
    await bob.context.close()

    // Alice sends many messages
    for (let i = 1; i <= 10; i++) {
      await sendChannelMessage(alice.page, `Offline msg ${i} — ext ${i}`)
    }
    await alice.page.waitForTimeout(5_000)

    // Bob returns
    bob = await createUserContext(browser, 'bob-ext2', USERS.bob.username, USERS.bob.password)
    await login(bob)
    await selectServer(bob.page, 'Extended Offline Server')
    await selectChannel(bob.page, 'offline-ext')

    // Should see all 10 messages
    for (let i = 1; i <= 10; i++) {
      await waitForMessage(bob.page, `Offline msg ${i} — ext ${i}`, 30_000)
    }

    await assertNoDecryptionFailures(bob.page)
    await assertConvergence(alice.page, bob.page, 'extended offline')
  })
})
