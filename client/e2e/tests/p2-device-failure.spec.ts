/**
 * P2: Media device failure degradation.
 * Covers: R-VOICE-5
 */
import { test, expect } from '@playwright/test'
import { createUserContext, signup, type UserContext } from '../helpers/auth'
import { createServer, createVoiceChannel, getInviteCode, joinServerWithCode, selectServer } from '../helpers/server'
import { joinVoiceChannel, disconnectCall, toggleCamera } from '../helpers/voice'
import { USERS, CHANNELS } from '../fixtures/test-data'

let alice: UserContext
let bob: UserContext

test.describe('P2: Device failure degradation', () => {
  test.beforeAll(async ({ browser }) => {
    alice = await createUserContext(browser, 'alice', USERS.alice.username, USERS.alice.password)
    bob = await createUserContext(browser, 'bob', USERS.bob.username, USERS.bob.password)
    await signup(alice)
    await signup(bob)

    await createServer(alice.page, 'Device Failure Server')
    const code = await getInviteCode(alice.page)
    await joinServerWithCode(bob.page, code)
    await createVoiceChannel(alice.page, CHANNELS.voice)
    await selectServer(bob.page, 'Device Failure Server')
  })

  test.afterAll(async () => {
    await alice.context.close()
    await bob.context.close()
  })

  test('App does not get stuck when media device fails (R-VOICE-5)', async () => {
    // Join voice channel
    await joinVoiceChannel(alice.page, CHANNELS.voice)
    await joinVoiceChannel(bob.page, CHANNELS.voice)

    // Revoke camera permissions mid-call via page.context().grantPermissions
    // This simulates a device becoming unavailable
    await alice.context.clearPermissions()

    // Try toggling camera — should show an error state, not hang
    await toggleCamera(alice.page)
    await alice.page.waitForTimeout(3_000)

    // The app should still be responsive and not stuck
    const disconnectBtn = alice.page.locator('[data-testid="disconnect-call"]')
    await expect(disconnectBtn).toBeVisible()

    // Should be able to disconnect normally
    await disconnectCall(alice.page)
    await disconnectCall(bob.page)

    // No crash — page is still usable
    await expect(alice.page.locator('[data-testid="main-page"]')).toBeVisible()
  })
})
