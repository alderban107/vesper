/**
 * P1: Multi-device login and encrypted message access.
 * Covers: R-AUTH-3, R-E2EE-3, R-E2EE-4, R-SYNC-4
 *
 * Tests that a second device can read existing DM and channel messages
 * after going through the device trust gate.
 */

import { test, expect } from '@playwright/test'
import { createUserContext, signup, login, approveWithRecoveryKey, type UserContext } from '../helpers/auth'
import { createServer, createChannel, getInviteCode, joinServerWithCode, selectServer, selectChannel } from '../helpers/server'
import { sendChannelMessage } from '../helpers/channel'
import { createDm, selectDm, sendDmMessage } from '../helpers/dm'
import { waitForMessage, waitForAppShell, waitForDeviceTrustGate } from '../helpers/wait'
import { assertNoDecryptionFailures } from '../helpers/assertions'
import { USERS } from '../fixtures/test-data'

let alice1: UserContext // Alice's first device
let alice2: UserContext // Alice's second device
let bob: UserContext

test.describe('P1: Multi-device encrypted message access', () => {
  test.afterEach(async () => {
    if (alice1?.context) await alice1.context.close().catch(() => {})
    if (alice2?.context) await alice2.context.close().catch(() => {})
    if (bob?.context) await bob.context.close().catch(() => {})
  })

  test('New device reads existing DM messages after recovery key approval (R-E2EE-4)', async ({ browser }) => {
    // --- Device 1: Alice signs up and exchanges DMs with Bob ---
    alice1 = await createUserContext(browser, 'alice-dev1', USERS.alice.username, USERS.alice.password)
    bob = await createUserContext(browser, 'bob-multidev', USERS.bob.username, USERS.bob.password)
    await signup(alice1)
    await signup(bob)

    const recoveryKey = alice1.recoveryKey!
    expect(recoveryKey).toBeTruthy()

    // Alice and Bob exchange DMs on device 1
    await createDm(alice1.page, USERS.bob.username)
    await selectDm(bob.page, USERS.alice.username)

    await sendDmMessage(alice1.page, 'Device 1 msg — multi alpha')
    await waitForMessage(bob.page, 'Device 1 msg — multi alpha')

    await sendDmMessage(bob.page, 'Bob reply — multi bravo')
    await waitForMessage(alice1.page, 'Bob reply — multi bravo')

    await sendDmMessage(alice1.page, 'Another from device 1 — multi charlie')
    await waitForMessage(bob.page, 'Another from device 1 — multi charlie')

    // Verify device 1 can see all messages
    await assertNoDecryptionFailures(alice1.page)

    // --- Device 2: Alice logs in on a new device ---
    alice2 = await createUserContext(browser, 'alice-dev2', USERS.alice.username, USERS.alice.password)
    await login(alice2)

    // Device trust gate should appear
    await waitForDeviceTrustGate(alice2.page)

    // Approve with recovery key
    await approveWithRecoveryKey(alice2.page, recoveryKey)
    await waitForAppShell(alice2.page)

    // Navigate to the DM with Bob on device 2
    await selectDm(alice2.page, USERS.bob.username)

    // Wait for messages to load and decrypt — the recovery mechanism needs time
    // to establish the MLS group on the new device
    await waitForMessage(alice2.page, 'Device 1 msg — multi alpha', 30_000)
    await waitForMessage(alice2.page, 'Bob reply — multi bravo', 10_000)
    await waitForMessage(alice2.page, 'Another from device 1 — multi charlie', 10_000)

    // No "syncing" or "approve" placeholders should remain
    await assertNoDecryptionFailures(alice2.page)
  })

  test('New device reads existing channel messages after approval (R-E2EE-4, R-SYNC-4)', async ({ browser }) => {
    // --- Device 1: Alice signs up and exchanges channel messages ---
    alice1 = await createUserContext(browser, 'alice-ch-dev1', USERS.alice.username, USERS.alice.password)
    bob = await createUserContext(browser, 'bob-ch-multidev', USERS.bob.username, USERS.bob.password)
    await signup(alice1)
    await signup(bob)

    const recoveryKey = alice1.recoveryKey!

    await createServer(alice1.page, 'MultiDev Server')
    const code = await getInviteCode(alice1.page)
    await joinServerWithCode(bob.page, code)

    await createChannel(alice1.page, 'multidev-test')
    await selectChannel(alice1.page, 'multidev-test')
    await selectServer(bob.page, 'MultiDev Server')
    await selectChannel(bob.page, 'multidev-test')

    await sendChannelMessage(alice1.page, 'Channel from dev1 — multidev delta')
    await waitForMessage(bob.page, 'Channel from dev1 — multidev delta')

    await sendChannelMessage(bob.page, 'Bob channel reply — multidev echo')
    await waitForMessage(alice1.page, 'Bob channel reply — multidev echo')

    await assertNoDecryptionFailures(alice1.page)

    // --- Device 2: Alice logs in and checks channel ---
    alice2 = await createUserContext(browser, 'alice-ch-dev2', USERS.alice.username, USERS.alice.password)
    await login(alice2)
    await waitForDeviceTrustGate(alice2.page)
    await approveWithRecoveryKey(alice2.page, recoveryKey)
    await waitForAppShell(alice2.page)

    await selectServer(alice2.page, 'MultiDev Server')
    await selectChannel(alice2.page, 'multidev-test')

    await waitForMessage(alice2.page, 'Channel from dev1 — multidev delta', 30_000)
    await waitForMessage(alice2.page, 'Bob channel reply — multidev echo', 10_000)

    await assertNoDecryptionFailures(alice2.page)
  })

  test('New device can send and receive messages after approval (R-E2EE-3)', async ({ browser }) => {
    // --- Setup: Alice signs up, gets recovery key ---
    alice1 = await createUserContext(browser, 'alice-send-dev1', USERS.alice.username, USERS.alice.password)
    bob = await createUserContext(browser, 'bob-send-multidev', USERS.bob.username, USERS.bob.password)
    await signup(alice1)
    await signup(bob)

    const recoveryKey = alice1.recoveryKey!

    // Create DM on device 1
    await createDm(alice1.page, USERS.bob.username)
    await selectDm(bob.page, USERS.alice.username)
    await sendDmMessage(alice1.page, 'Setup msg — send foxtrot')
    await waitForMessage(bob.page, 'Setup msg — send foxtrot')

    // --- Device 2: Alice logs in and sends a NEW message ---
    alice2 = await createUserContext(browser, 'alice-send-dev2', USERS.alice.username, USERS.alice.password)
    await login(alice2)
    await waitForDeviceTrustGate(alice2.page)
    await approveWithRecoveryKey(alice2.page, recoveryKey)
    await waitForAppShell(alice2.page)

    await selectDm(alice2.page, USERS.bob.username)

    // Wait for encryption to be ready on the new device
    await waitForMessage(alice2.page, 'Setup msg — send foxtrot', 30_000)

    // Send a message FROM the new device
    await sendDmMessage(alice2.page, 'From device 2 — send golf')

    // Bob should receive the message sent from device 2
    await waitForMessage(bob.page, 'From device 2 — send golf', 15_000)

    // Device 1 should also see the new message (if still connected)
    await selectDm(alice1.page, USERS.bob.username)
    await waitForMessage(alice1.page, 'From device 2 — send golf', 15_000)

    await assertNoDecryptionFailures(alice2.page)
    await assertNoDecryptionFailures(bob.page)
  })
})
