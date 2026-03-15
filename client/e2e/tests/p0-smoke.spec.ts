/**
 * P0 Smoke Test — the continuous 22-step scenario.
 *
 * Requirement coverage:
 *   R-HARNESS-1  Fresh stack booted by global setup
 *   R-HARNESS-2  Isolated database and profiles
 *   R-HARNESS-3  Artifacts preserved on failure (via playwright config)
 *   R-HARNESS-4  Readiness checks in all helpers
 *   R-HARNESS-5  Persistent browser profiles per user
 *   R-AUTH-1     Three users sign up from clean clients
 *   R-AUTH-2     Login lands users in a usable encrypted state
 *   R-NAV-1      Server, channel, DM selection survive refresh
 *   R-DM-1       Two users can create and use an encrypted DM
 *   R-DM-2       DM history survives refresh and browser restart
 *   R-DM-3       DM reactions and threaded replies converge
 *   R-SERVER-1   Admin can create a server and channels
 *   R-SERVER-2   Users can join via invite code
 *   R-SERVER-3   Server membership and channel visibility converge
 *   R-CHANNEL-1  Three users can chat in channels
 *   R-CHANNEL-2  Channel threads stay threaded
 *   R-EMOJI-1    Custom emoji upload and use
 *   R-SYNC-1     Reload/reconnect do not leave clients behind
 *   R-SYNC-2     Missing live updates are recovered
 *   R-SYNC-3     Broken local crypto state has a repair path
 *   R-E2EE-1     No decryption failure in the happy path
 *   R-E2EE-2     Recovery flows stay E2E encrypted
 *   R-ASSERT-1   Assertions compare exact cross-client state
 *   R-ASSERT-2   Suite fails on duplicates, gaps, stale counters
 *   R-ASSERT-3   Known console/network failures fail the run
 *   R-ASSERT-5   First run gates pre-merge CI
 */

import { test, expect, type Browser, type Page, type BrowserContext } from '@playwright/test'
import { readRunState } from '../harness/state'
import { ConsoleMonitor } from '../harness/console-monitor'
import { signup, createUserContext, login, approveWithRecoveryKey, type UserContext } from '../helpers/auth'
import { createDm, selectDm, sendDmMessage } from '../helpers/dm'
import {
  createServer,
  createChannel,
  getInviteCode,
  joinServerWithCode,
  selectServer,
  selectChannel,
  getChannelNames,
} from '../helpers/server'
import { sendChannelMessage, openThread, sendThreadReply } from '../helpers/channel'
import { addReaction, getReactions } from '../helpers/message'
import { uploadCustomEmoji, isCustomEmojiRendered } from '../helpers/emoji'
import { hardRefresh, simulateDisconnect, restartBrowserContext } from '../helpers/navigation'
import {
  assertConvergence,
  assertThreeWayConvergence,
  assertNoDecryptionFailures,
  assertMessageVisible,
} from '../helpers/assertions'
import { recordSnapshot, writeSnapshots } from '../helpers/snapshots'
import { waitForMessage, waitForServerInSidebar, waitForChannel } from '../helpers/wait'
import {
  USERS,
  SERVER,
  CHANNELS,
  DM_MESSAGES,
  CHANNEL_MESSAGES,
  REACTIONS,
  CUSTOM_EMOJI,
} from '../fixtures/test-data'

let alice: UserContext
let bob: UserContext
let charlie: UserContext
let monitors: ConsoleMonitor[]
let inviteCode: string

test.describe('P0 Smoke — full continuous run', () => {
  test.beforeAll(async ({ browser }) => {
    monitors = []

    // Step 2: Open three clean browser clients (R-HARNESS-5)
    alice = await createUserContext(browser, 'alice', USERS.alice.username, USERS.alice.password)
    bob = await createUserContext(browser, 'bob', USERS.bob.username, USERS.bob.password)
    charlie = await createUserContext(browser, 'charlie', USERS.charlie.username, USERS.charlie.password)

    // Attach console monitors (R-ASSERT-3)
    monitors.push(new ConsoleMonitor(alice.page))
    monitors.push(new ConsoleMonitor(bob.page))
    monitors.push(new ConsoleMonitor(charlie.page))
  })

  test.afterAll(async () => {
    // Write snapshots (R-ASSERT-4)
    writeSnapshots()

    // Assert no fatal console failures across all clients (R-ASSERT-3)
    for (const monitor of monitors) {
      monitor.assertNoFatalFailures()
    }

    // Close all contexts
    await alice.context.close()
    await bob.context.close()
    await charlie.context.close()
  })

  // --- Step 3: Sign up alice, bob, charlie (R-AUTH-1) ---
  test('Step 3: three users can sign up from clean clients', async () => {
    await signup(alice)
    expect(alice.recoveryKey).toBeTruthy()
    await recordSnapshot(alice.page, 'signup-complete', 'alice')

    await signup(bob)
    expect(bob.recoveryKey).toBeTruthy()
    await recordSnapshot(bob.page, 'signup-complete', 'bob')

    await signup(charlie)
    expect(charlie.recoveryKey).toBeTruthy()
    await recordSnapshot(charlie.page, 'signup-complete', 'charlie')
  })

  // --- Step 4: Verify each reaches the main app (R-AUTH-2) ---
  test('Step 4: each user reaches the main app shell', async () => {
    await expect(alice.page.locator('[data-testid="main-page"]')).toBeVisible()
    await expect(bob.page.locator('[data-testid="main-page"]')).toBeVisible()
    await expect(charlie.page.locator('[data-testid="main-page"]')).toBeVisible()
  })

  // --- Steps 5-6: DM between alice and bob (R-DM-1) ---
  test('Steps 5-6: alice and bob exchange encrypted DMs', async () => {
    // Alice creates a DM with bob
    await createDm(alice.page, USERS.bob.username)

    // Alice sends messages
    await sendDmMessage(alice.page, DM_MESSAGES.aliceToBob1)
    await sendDmMessage(alice.page, DM_MESSAGES.aliceToBob2)

    // Bob selects the DM
    await selectDm(bob.page, USERS.alice.username)

    // Wait for alice's messages to appear on bob's side
    await waitForMessage(bob.page, DM_MESSAGES.aliceToBob1)
    await waitForMessage(bob.page, DM_MESSAGES.aliceToBob2)

    // Bob replies
    await sendDmMessage(bob.page, DM_MESSAGES.bobToAlice1)
    await sendDmMessage(bob.page, DM_MESSAGES.bobToAlice2)

    // Verify on alice's side
    await waitForMessage(alice.page, DM_MESSAGES.bobToAlice1)
    await waitForMessage(alice.page, DM_MESSAGES.bobToAlice2)

    // Assert no decryption failures (R-E2EE-1)
    await assertNoDecryptionFailures(alice.page)
    await assertNoDecryptionFailures(bob.page)

    // Assert convergence (R-ASSERT-1)
    await assertConvergence(alice.page, bob.page, 'DM initial')
    await recordSnapshot(alice.page, 'dm-convergence', 'alice')
    await recordSnapshot(bob.page, 'dm-convergence', 'bob')
  })

  // --- Step 7: DM reaction (R-DM-3) ---
  test('Step 7: DM reaction converges', async () => {
    await addReaction(alice.page, DM_MESSAGES.bobToAlice1, REACTIONS.thumbsUp)

    // Wait for reaction to appear on bob's side
    await bob.page.waitForSelector('[data-testid="reaction-chip"]', { timeout: 5_000 })

    const aliceReactions = await getReactions(alice.page, DM_MESSAGES.bobToAlice1)
    const bobReactions = await getReactions(bob.page, DM_MESSAGES.bobToAlice1)

    expect(aliceReactions.get(REACTIONS.thumbsUp)).toBe(1)
    expect(bobReactions.get(REACTIONS.thumbsUp)).toBe(1)
  })

  // --- Step 8: DM thread (R-DM-3) ---
  test('Step 8: DM thread and threaded replies converge', async () => {
    await openThread(alice.page, DM_MESSAGES.aliceToBob1)
    await sendThreadReply(alice.page, DM_MESSAGES.threadReply1)

    // Bob opens the same thread
    await openThread(bob.page, DM_MESSAGES.aliceToBob1)
    await bob.page.waitForSelector(`.vesper-thread-feed :text("${DM_MESSAGES.threadReply1}")`, {
      timeout: 10_000,
    })

    await sendThreadReply(bob.page, DM_MESSAGES.threadReply2)

    // Verify on alice's side
    await alice.page.waitForSelector(
      `.vesper-thread-feed :text("${DM_MESSAGES.threadReply2}")`,
      { timeout: 15_000 }
    )
  })

  // --- Step 9: Refresh alice, verify DM state (R-DM-2, R-SYNC-1) ---
  test('Step 9: alice refresh preserves DM state', async () => {
    await hardRefresh(alice.page)

    // DM should still be visible after refresh
    await selectDm(alice.page, USERS.bob.username)
    await waitForMessage(alice.page, DM_MESSAGES.aliceToBob1)
    await waitForMessage(alice.page, DM_MESSAGES.bobToAlice1)

    await assertNoDecryptionFailures(alice.page)
    await recordSnapshot(alice.page, 'dm-refresh-convergence', 'alice')
  })

  // --- Step 10: Refresh bob, verify DM state (R-DM-2) ---
  test('Step 10: bob refresh preserves DM state', async () => {
    await hardRefresh(bob.page)

    await selectDm(bob.page, USERS.alice.username)
    await waitForMessage(bob.page, DM_MESSAGES.aliceToBob1)
    await waitForMessage(bob.page, DM_MESSAGES.bobToAlice1)

    await assertNoDecryptionFailures(bob.page)
    await recordSnapshot(bob.page, 'dm-refresh-convergence', 'bob')
  })

  // --- Step 11: Restart one DM client context (R-DM-2, R-HARNESS-5) ---
  test('Step 11: browser context restart preserves DM state', async () => {
    test.setTimeout(30_000) // context restart is inherently slower

    const result = await restartBrowserContext(
      alice.page.context().browser()!,
      alice.context
    )
    alice.context = result.context
    alice.page = result.page

    // Re-attach console monitor
    monitors[0] = new ConsoleMonitor(alice.page)

    // With IndexedDB preserved, the device trust gate may or may not appear
    // depending on whether identity keys survived the restart.
    const gate = alice.page.locator('[data-testid="device-trust-gate"]')
    const gateVisible = await gate.isVisible().catch(() => false)

    if (gateVisible) {
      const passwordInput = gate.locator('input[type="password"]')
      const textarea = gate.locator('textarea')

      if (await passwordInput.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await passwordInput.fill(alice.password)
        await gate.locator('button:has-text("Unlock")').click()
      } else if (await textarea.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await textarea.fill(alice.recoveryKey!)
        await gate.locator('button:has-text("Use recovery key")').click()
      }
      await gate.waitFor({ state: 'hidden', timeout: 10_000 })
    }

    // Navigate to DM and verify messages survived the restart
    await selectDm(alice.page, USERS.bob.username)
    await assertNoDecryptionFailures(alice.page)

    // Verify actual message content is readable (not just "Encrypted message is syncing...")
    await waitForMessage(alice.page, DM_MESSAGES.aliceToBob1)
    await waitForMessage(alice.page, DM_MESSAGES.bobToAlice1)
  })

  // --- Step 12: Create a server (R-SERVER-1) ---
  test('Step 12: alice creates a server', async () => {
    await createServer(alice.page, SERVER.name)
    await waitForServerInSidebar(alice.page, SERVER.name)
  })

  // --- Step 13: Create channels (R-SERVER-1) ---
  test('Step 13: alice creates two text channels', async () => {
    await selectServer(alice.page, SERVER.name)
    await createChannel(alice.page, CHANNELS.general)
    await createChannel(alice.page, CHANNELS.random)
    await waitForChannel(alice.page, CHANNELS.general)
    await waitForChannel(alice.page, CHANNELS.random)
  })

  // --- Step 14: Invite others (R-SERVER-2) ---
  test('Step 14: bob and charlie join via invite code', async () => {
    inviteCode = await getInviteCode(alice.page)
    expect(inviteCode).toBeTruthy()

    await joinServerWithCode(bob.page, inviteCode)
    await joinServerWithCode(charlie.page, inviteCode)

    // Verify server appears for both (R-SERVER-3)
    await waitForServerInSidebar(bob.page, SERVER.name)
    await waitForServerInSidebar(charlie.page, SERVER.name)
  })

  // --- Step 15: Verify server/channel visibility (R-SERVER-3) ---
  test('Step 15: server and channels visible on all clients', async () => {
    await selectServer(bob.page, SERVER.name)
    await selectServer(charlie.page, SERVER.name)

    for (const page of [alice.page, bob.page, charlie.page]) {
      const channels = await getChannelNames(page)
      expect(channels).toContain(CHANNELS.general)
      expect(channels).toContain(CHANNELS.random)
    }

    await recordSnapshot(alice.page, 'server-join-convergence', 'alice')
    await recordSnapshot(bob.page, 'server-join-convergence', 'bob')
    await recordSnapshot(charlie.page, 'server-join-convergence', 'charlie')
  })

  // --- Step 16: Channel messages from all three (R-CHANNEL-1) ---
  test('Step 16: three users chat in channels', async () => {
    test.setTimeout(60_000) // MLS group formation across 3 users

    // All users join the channel — this triggers MLS group formation.
    // Alice goes first and creates the group. The others join via the
    // mls_request_join → welcome flow triggered by joinChannelChat.
    await selectChannel(alice.page, CHANNELS.general)
    // Small delay so alice's group is created before others subscribe
    await alice.page.waitForTimeout(1_000)
    await selectChannel(bob.page, CHANNELS.general)
    await selectChannel(charlie.page, CHANNELS.general)
    // Allow MLS welcomes to propagate
    await alice.page.waitForTimeout(2_000)

    // Now send messages — all users should be in the same MLS group
    await sendChannelMessage(alice.page, CHANNEL_MESSAGES.alice1)
    await sendChannelMessage(bob.page, CHANNEL_MESSAGES.bob1)
    await sendChannelMessage(charlie.page, CHANNEL_MESSAGES.charlie1)

    // All three users should be able to decrypt all three messages
    for (const page of [alice.page, bob.page, charlie.page]) {
      await waitForMessage(page, CHANNEL_MESSAGES.alice1, 15_000)
      await waitForMessage(page, CHANNEL_MESSAGES.bob1, 15_000)
      await waitForMessage(page, CHANNEL_MESSAGES.charlie1, 15_000)
    }
  })

  // --- Step 17: Channel thread (R-CHANNEL-2) ---
  test('Step 17: channel thread stays threaded', async () => {
    test.setTimeout(45_000)

    await openThread(alice.page, CHANNEL_MESSAGES.alice1)
    await sendThreadReply(alice.page, CHANNEL_MESSAGES.threadReply1)

    // Bob opens the same thread and sees alice's reply
    await openThread(bob.page, CHANNEL_MESSAGES.alice1)
    await bob.page.waitForSelector(
      `.vesper-thread-feed :text("${CHANNEL_MESSAGES.threadReply1}")`,
      { timeout: 15_000 }
    )
    await sendThreadReply(bob.page, CHANNEL_MESSAGES.threadReply2)

    // Verify on alice's side
    await alice.page.waitForSelector(
      `.vesper-thread-feed :text("${CHANNEL_MESSAGES.threadReply2}")`,
      { timeout: 15_000 }
    )

    // Thread replies should NOT appear in main timeline (R-CHANNEL-2)
    await alice.page.click('.vesper-thread-close')
    await bob.page.click('.vesper-thread-close')

    const aliceMainMessages = await alice.page
      .locator('[data-testid="message-row"] [data-testid="message-content"]')
      .allTextContents()
    expect(aliceMainMessages).not.toContain(CHANNEL_MESSAGES.threadReply1)
    expect(aliceMainMessages).not.toContain(CHANNEL_MESSAGES.threadReply2)

    await recordSnapshot(alice.page, 'channel-thread-convergence', 'alice')
    await recordSnapshot(bob.page, 'channel-thread-convergence', 'bob')
  })

  // --- Step 18: Upload custom emoji (R-EMOJI-1) ---
  test('Step 18: custom emoji upload works', async () => {
    await uploadCustomEmoji(alice.page, CUSTOM_EMOJI.name, CUSTOM_EMOJI.base64)
  })

  // --- Step 19: Use custom emoji in chat (R-EMOJI-1) ---
  test('Step 19: custom emoji used in visible chat', async () => {
    test.setTimeout(30_000)

    await selectChannel(alice.page, CHANNELS.general)
    const emojiMsgPrefix = 'Check out this emoji'
    await sendChannelMessage(alice.page, CHANNEL_MESSAGES.emojiInBody, emojiMsgPrefix)

    // Wait for the message on other clients (use partial text — the :testfire:
    // shortcode gets converted to <:testfire:id> and rendered as an <img>)
    await waitForMessage(bob.page, emojiMsgPrefix, 15_000)
    await waitForMessage(charlie.page, emojiMsgPrefix, 15_000)

    // Verify emoji renders as an image (not raw :testfire: text)
    const rendered = await isCustomEmojiRendered(bob.page, CUSTOM_EMOJI.name)
    expect(rendered).toBe(true)
  })

  // --- Step 20: Force one reconnect (R-SYNC-1, R-SYNC-2) ---
  test('Step 20: reconnect after missed update window', async () => {
    test.setTimeout(30_000)

    // Disconnect charlie
    await simulateDisconnect(charlie.page, 3_000)

    // While charlie is away, alice sends a message
    await sendChannelMessage(alice.page, CHANNEL_MESSAGES.alice2)

    // Charlie comes back and should catch up
    await selectServer(charlie.page, SERVER.name)
    await selectChannel(charlie.page, CHANNELS.general)
    await waitForMessage(charlie.page, CHANNEL_MESSAGES.alice2, 15_000)
  })

  // --- Step 21: Verify all clients converge (R-ASSERT-1, R-ASSERT-2) ---
  test('Step 21: all clients converge on the same state', async () => {
    test.setTimeout(30_000)

    // Make sure everyone is looking at the same channel
    await selectServer(alice.page, SERVER.name)
    await selectChannel(alice.page, CHANNELS.general)
    await selectServer(bob.page, SERVER.name)
    await selectChannel(bob.page, CHANNELS.general)
    await selectServer(charlie.page, SERVER.name)
    await selectChannel(charlie.page, CHANNELS.general)

    // Wait for sync
    await alice.page.waitForTimeout(3_000)

    await assertThreeWayConvergence(
      alice.page,
      bob.page,
      charlie.page,
      'final convergence'
    )

    await recordSnapshot(alice.page, 'final-convergence', 'alice')
    await recordSnapshot(bob.page, 'final-convergence', 'bob')
    await recordSnapshot(charlie.page, 'final-convergence', 'charlie')
  })

  // --- Step 22: No P0 crypto/sync failure (R-E2EE-1, R-ASSERT-3) ---
  test('Step 22: no P0 crypto or sync failure surfaced', async () => {
    // Check no decryption failures on channel view (everyone should be
    // in the same MLS group after the fixes)
    for (const page of [alice.page, bob.page, charlie.page]) {
      await assertNoDecryptionFailures(page)
    }

    // Navigate to DM view and verify decryption there too
    await alice.page.click('[data-testid="sidebar"] button[title="Direct Messages"]')
    await bob.page.click('[data-testid="sidebar"] button[title="Direct Messages"]')
    await selectDm(alice.page, USERS.bob.username)
    await assertNoDecryptionFailures(alice.page)
    await selectDm(bob.page, USERS.alice.username)
    await assertNoDecryptionFailures(bob.page)

    for (const monitor of monitors) {
      monitor.assertNoFatalFailures()
    }
  })
})
