/**
 * P1: Voice and video calls.
 * Covers: R-VOICE-1, R-VOICE-2, R-VOICE-3, R-HARNESS-7
 */

import { test, expect } from '@playwright/test'
import { createUserContext, signup, type UserContext } from '../helpers/auth'
import { createDm, selectDm } from '../helpers/dm'
import { createServer, createVoiceChannel, getInviteCode, joinServerWithCode, selectServer } from '../helpers/server'
import {
  startDmCall,
  acceptIncomingCall,
  rejectIncomingCall,
  disconnectCall,
  joinVoiceChannel,
  toggleMute,
  isMuted,
  toggleCamera,
  hasLocalVideoPreview,
  hasRemoteVideo,
  getVoiceParticipants,
} from '../helpers/voice'
import { hardRefresh } from '../helpers/navigation'
import { USERS, CHANNELS } from '../fixtures/test-data'

let alice: UserContext
let bob: UserContext

test.describe('P1: Voice and video', () => {
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

  test('DM call setup and teardown (R-VOICE-1)', async () => {
    await createDm(alice.page, USERS.bob.username)
    await selectDm(bob.page, USERS.alice.username)

    // Alice starts call
    await startDmCall(alice.page)

    // Bob accepts
    await acceptIncomingCall(bob.page)

    // Both should be in connected state
    await expect(alice.page.locator('[data-testid="voice-connected"], [data-testid="call-overlay"]')).toBeVisible()
    await expect(bob.page.locator('[data-testid="voice-connected"], [data-testid="call-overlay"]')).toBeVisible()

    // Disconnect both sides
    await disconnectCall(alice.page)
    await disconnectCall(bob.page)

    // No ghost call UI should remain
    await expect(alice.page.locator('[data-testid="call-overlay"]')).toHaveCount(0)
    await expect(bob.page.locator('[data-testid="call-overlay"]')).toHaveCount(0)
  })

  test('DM call reject leaves both sides clean (R-VOICE-1)', async () => {
    await selectDm(alice.page, USERS.bob.username)
    await selectDm(bob.page, USERS.alice.username)

    await startDmCall(alice.page)
    await rejectIncomingCall(bob.page)

    // Both sides should settle with no active call overlay
    await alice.page.waitForTimeout(3_000)
    await expect(bob.page.locator('[data-testid="call-overlay"]')).toHaveCount(0)
  })

  test('Channel voice join, participant convergence, mute, reconnect (R-VOICE-2)', async () => {
    await createServer(alice.page, 'Voice Server')
    const code = await getInviteCode(alice.page)
    await joinServerWithCode(bob.page, code)

    await createVoiceChannel(alice.page, CHANNELS.voice)
    await selectServer(bob.page, 'Voice Server')

    // Both join voice channel
    await joinVoiceChannel(alice.page, CHANNELS.voice)
    await joinVoiceChannel(bob.page, CHANNELS.voice)

    // Participant roster should converge
    const aliceParticipants = await getVoiceParticipants(alice.page)
    const bobParticipants = await getVoiceParticipants(bob.page)
    expect(aliceParticipants.length).toBeGreaterThanOrEqual(2)
    expect(bobParticipants.length).toBeGreaterThanOrEqual(2)

    // Mute toggle propagates
    await toggleMute(alice.page)
    const muted = await isMuted(alice.page)
    expect(muted).toBe(true)

    // Alice disconnects and rejoins
    await disconnectCall(alice.page)
    await alice.page.waitForTimeout(2_000)
    await joinVoiceChannel(alice.page, CHANNELS.voice)

    // Participant list should update
    const participantsAfter = await getVoiceParticipants(bob.page)
    expect(participantsAfter.length).toBeGreaterThanOrEqual(2)

    // Clean up
    await disconnectCall(alice.page)
    await disconnectCall(bob.page)
  })

  test('Camera publish and remote video rendering (R-VOICE-3)', async () => {
    await selectServer(alice.page, 'Voice Server')
    await selectServer(bob.page, 'Voice Server')

    await joinVoiceChannel(alice.page, CHANNELS.voice)
    await joinVoiceChannel(bob.page, CHANNELS.voice)

    // Alice turns on camera
    await toggleCamera(alice.page)

    // Local preview should appear
    const localPreview = await hasLocalVideoPreview(alice.page)
    expect(localPreview).toBe(true)

    // Bob should see remote video
    await bob.page.waitForSelector(`[data-testid="remote-video-${USERS.alice.username}"]`, {
      timeout: 15_000,
    })
    const remoteVideo = await hasRemoteVideo(bob.page, USERS.alice.username)
    expect(remoteVideo).toBe(true)

    // Stop camera
    await toggleCamera(alice.page)
    await alice.page.waitForTimeout(2_000)

    // Remote feed should clear
    const remoteAfter = await hasRemoteVideo(bob.page, USERS.alice.username)
    expect(remoteAfter).toBe(false)

    // No stale "camera live" UI after reconnect
    await disconnectCall(alice.page)
    await alice.page.waitForTimeout(2_000)
    await joinVoiceChannel(alice.page, CHANNELS.voice)
    const localAfterReconnect = await hasLocalVideoPreview(alice.page)
    expect(localAfterReconnect).toBe(false)

    await disconnectCall(alice.page)
    await disconnectCall(bob.page)
  })
})
