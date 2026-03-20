/**
 * P1: Multi-device login and encrypted message access.
 * Covers: R-AUTH-3, R-E2EE-3, R-E2EE-4, R-SYNC-4
 *
 * Tests that a second device can read existing DM and channel messages
 * after going through the device trust gate.
 *
 * Depends on P0 having already signed up alice_e2e and bob_e2e.
 *
 * NOTE: Old P0 messages will show as "syncing" on new device contexts due to
 * MLS forward secrecy. This test only verifies that messages sent DURING the
 * test are decryptable across devices.
 */

import { test } from '@playwright/test'
import { createUserContext, login, approveWithRecoveryKey, type UserContext } from '../helpers/auth'
import { createServer, createChannel, getInviteCode, joinServerWithCode, selectServer, selectChannel } from '../helpers/server'
import { sendChannelMessage } from '../helpers/channel'
import { selectDm, sendDmMessage } from '../helpers/dm'
import { waitForMessage, waitForAppShell, waitForSocketConnected } from '../helpers/wait'
import { assertNoDecryptionFailures } from '../helpers/assertions'
import { getRecoveryKey } from '../harness/state'
import { USERS } from '../fixtures/test-data'

/** Standard timeout for messages that go through MLS encryption. */
const MSG_TIMEOUT = 15_000

let alice1: UserContext // Alice's existing session (device 1)
let alice2: UserContext // Alice's new device (device 2)
let bob: UserContext

test.describe('P1: Multi-device encrypted message access', () => {
  test.afterEach(async () => {
    if (alice1?.context) await alice1.context.close().catch(() => {})
    if (alice2?.context) await alice2.context.close().catch(() => {})
    if (bob?.context) await bob.context.close().catch(() => {})
  })

  test('New device reads DM messages sent in this session after approval (R-E2EE-4)', async ({ browser }) => {
    const recoveryKey = getRecoveryKey(USERS.alice.username)

    // --- Device 1: Alice logs in first to establish the MLS group ---
    alice1 = await createUserContext(browser, 'alice-md-dev1', USERS.alice.username, USERS.alice.password)
    await login(alice1)

    // Alice opens DM — triggers MLS group creation (takes ~4s for bootstrap)
    await selectDm(alice1.page, USERS.bob.username)

    // Bob logs in — this takes several seconds (navigate, fill, submit, trust gate)
    // giving Alice time to create the MLS group. Bob's login also purges stale
    // key packages so Alice's join handler uses fresh ones.
    bob = await createUserContext(browser, 'bob-md', USERS.bob.username, USERS.bob.password)
    await login(bob)
    await selectDm(bob.page, USERS.alice.username)

    // Exchange messages between the two devices
    await sendDmMessage(alice1.page, 'Device 1 msg — multi alpha')
    await waitForMessage(bob.page, 'Device 1 msg — multi alpha', MSG_TIMEOUT)

    await sendDmMessage(alice1.page, 'Another from device 1 — multi charlie')
    await selectDm(bob.page, USERS.alice.username)
    await waitForMessage(bob.page, 'Another from device 1 — multi charlie', MSG_TIMEOUT)

    // --- Device 2: Alice logs in on a new device ---
    alice2 = await createUserContext(browser, 'alice-md-dev2', USERS.alice.username, USERS.alice.password)
    await login(alice2, { expectTrustGate: true })
    await approveWithRecoveryKey(alice2.page, recoveryKey)
    await waitForAppShell(alice2.page)

    // Navigate to the DM with Bob on device 2
    await selectDm(alice2.page, USERS.bob.username)

    // Verify messages sent in this session are readable on device 2
    await waitForMessage(alice2.page, 'Device 1 msg — multi alpha', MSG_TIMEOUT)
    await waitForMessage(alice2.page, 'Another from device 1 — multi charlie', MSG_TIMEOUT)
  })

  test('New device recovers channel history and stays live-synced with another trusted device (R-E2EE-4, R-SYNC-4)', async ({ browser }) => {
    const recoveryKey = getRecoveryKey(USERS.alice.username)

    // --- Device 1: Alice logs in first, creates server, then Bob joins ---
    alice1 = await createUserContext(browser, 'alice-md-ch-dev1', USERS.alice.username, USERS.alice.password)
    await login(alice1)

    await createServer(alice1.page, 'MultiDev Server')
    const code = await getInviteCode(alice1.page)

    // Bob logs in after Alice to join her MLS groups
    bob = await createUserContext(browser, 'bob-md-ch', USERS.bob.username, USERS.bob.password)
    await login(bob)
    await joinServerWithCode(bob.page, code)

    await createChannel(alice1.page, 'multidev-test')
    await createChannel(alice1.page, 'parking-lot')
    await selectChannel(alice1.page, 'multidev-test')
    // Let Alice's MLS group bootstrap before Bob joins
    await alice1.page.waitForTimeout(1_000)
    await selectServer(bob.page, 'MultiDev Server')
    await selectChannel(bob.page, 'multidev-test')
    // Allow MLS welcome to propagate to Bob
    await alice1.page.waitForTimeout(2_000)

    await sendChannelMessage(alice1.page, 'Channel from dev1 — multidev delta')
    await waitForMessage(bob.page, 'Channel from dev1 — multidev delta', MSG_TIMEOUT)

    await sendChannelMessage(bob.page, 'Bob channel reply — multidev echo')
    await waitForMessage(alice1.page, 'Bob channel reply — multidev echo', MSG_TIMEOUT)

    // Device 1 leaves the target channel so device 2 must rely on stored
    // recovery requests until this trusted sibling comes back later.
    await selectChannel(alice1.page, 'parking-lot')

    // --- Device 2: Alice logs in and checks channel ---
    alice2 = await createUserContext(browser, 'alice-md-ch-dev2', USERS.alice.username, USERS.alice.password)
    await login(alice2, { expectTrustGate: true })
    await approveWithRecoveryKey(alice2.page, recoveryKey)
    await waitForAppShell(alice2.page)

    await selectServer(alice2.page, 'MultiDev Server')
    await selectChannel(alice2.page, 'multidev-test')

    // Device 1 returns later and should answer the stored history request.
    await selectChannel(alice1.page, 'multidev-test')
    await waitForMessage(alice2.page, 'Channel from dev1 — multidev delta', MSG_TIMEOUT)
    await waitForMessage(alice2.page, 'Bob channel reply — multidev echo', MSG_TIMEOUT)

    // Once both trusted devices are online in the channel, new live messages
    // should converge across both of Alice's devices and Bob.
    await selectChannel(bob.page, 'multidev-test')
    await sendChannelMessage(bob.page, 'Bob after device 2 online — multidev foxtrot')
    await waitForMessage(alice1.page, 'Bob after device 2 online — multidev foxtrot', MSG_TIMEOUT)
    await waitForMessage(alice2.page, 'Bob after device 2 online — multidev foxtrot', MSG_TIMEOUT)

    await sendChannelMessage(alice2.page, 'Device 2 live channel send — multidev golf')
    await waitForMessage(alice1.page, 'Device 2 live channel send — multidev golf', MSG_TIMEOUT)
    await waitForMessage(bob.page, 'Device 2 live channel send — multidev golf', MSG_TIMEOUT)
  })

  test('New device can send and receive messages after approval (R-E2EE-3)', async ({ browser }) => {
    const recoveryKey = getRecoveryKey(USERS.alice.username)

    // --- Device 1: Establish the DM MLS group between Alice and Bob ---
    alice1 = await createUserContext(browser, 'alice-md-send-dev1', USERS.alice.username, USERS.alice.password)
    await login(alice1)
    await selectDm(alice1.page, USERS.bob.username)

    bob = await createUserContext(browser, 'bob-md-send', USERS.bob.username, USERS.bob.password)
    await login(bob)
    await selectDm(bob.page, USERS.alice.username)
    await sendDmMessage(alice1.page, 'Setup msg — send foxtrot')
    await waitForMessage(bob.page, 'Setup msg — send foxtrot', MSG_TIMEOUT)

    // Close device 1 before device 2 joins. For DMs, both Alice1 and Bob
    // would handle device 2's mls_request_join, creating conflicting MLS
    // commits that corrupt the group state. With Alice1 closed, only Bob
    // handles the join and produces a clean epoch transition.
    await alice1.context.close()

    // --- Device 2: Login, open DM, send and receive ---
    alice2 = await createUserContext(browser, 'alice-md-send-dev2', USERS.alice.username, USERS.alice.password)
    await login(alice2, { expectTrustGate: true })
    await approveWithRecoveryKey(alice2.page, recoveryKey)
    await waitForAppShell(alice2.page)

    await selectDm(alice2.page, USERS.bob.username)

    // Send from the new device. The encryption retry mechanism in
    // sendDmMessage handles MLS join timing — if encryption isn't ready
    // on the first attempt, it retries until the welcome arrives.
    await sendDmMessage(alice2.page, 'From device 2 — send golf')

    // Bob should receive the message sent from device 2
    await waitForMessage(bob.page, 'From device 2 — send golf', MSG_TIMEOUT)

    // Bob replies — device 2 should receive real-time messages
    await sendDmMessage(bob.page, 'Bob reply — send hotel')
    await waitForMessage(alice2.page, 'Bob reply — send hotel', MSG_TIMEOUT)
  })
})
