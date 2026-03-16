/**
 * P2: Screen share and share-audio.
 * Covers: R-VOICE-4
 */
import { test, expect } from '@playwright/test'
import { createUserContext, login, type UserContext } from '../helpers/auth'
import { createServer, createVoiceChannel, getInviteCode, joinServerWithCode, selectServer } from '../helpers/server'
import {
  joinVoiceChannel,
  disconnectCall,
  toggleScreenShare,
  hasRemoteScreenShare,
} from '../helpers/voice'
import { USERS, CHANNELS } from '../fixtures/test-data'

let alice: UserContext
let bob: UserContext

test.describe('P2: Screen share', () => {
  test.beforeAll(async ({ browser }) => {
    alice = await createUserContext(browser, 'alice', USERS.alice.username, USERS.alice.password)
    bob = await createUserContext(browser, 'bob', USERS.bob.username, USERS.bob.password)
    await login(alice)
    await login(bob)

    await createServer(alice.page, 'Screen Share Server')
    const code = await getInviteCode(alice.page)
    await joinServerWithCode(bob.page, code)
    await createVoiceChannel(alice.page, CHANNELS.voice)
    await selectServer(bob.page, 'Screen Share Server')
  })

  test.afterAll(async () => {
    await alice.context.close()
    await bob.context.close()
  })

  test('Screen share starts, shows on remote, and stops cleanly (R-VOICE-4)', async () => {
    // Both join voice
    await joinVoiceChannel(alice.page, CHANNELS.voice)
    await joinVoiceChannel(bob.page, CHANNELS.voice)

    // Alice starts screen share
    await toggleScreenShare(alice.page)

    // Bob should see remote screen share
    await bob.page.waitForSelector('[data-testid="remote-screen-share"]', { timeout: 15_000 })
    const remoteShare = await hasRemoteScreenShare(bob.page)
    expect(remoteShare).toBe(true)

    // End the call and ensure remote screen feed clears
    await disconnectCall(alice.page)
    await bob.page.waitForTimeout(1_000)
    const remoteAfter = await hasRemoteScreenShare(bob.page)
    expect(remoteAfter).toBe(false)

    await disconnectCall(bob.page)
  })
})
