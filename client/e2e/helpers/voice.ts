/**
 * Voice and video call helpers.
 * Covers: R-VOICE-1, R-VOICE-2, R-VOICE-3, R-VOICE-4, R-VOICE-5
 * Covers: R-HARNESS-7 (deterministic fake media)
 */

import type { Page } from '@playwright/test'

/** Start a DM call with the current conversation partner. */
export async function startDmCall(page: Page): Promise<void> {
  await page.click('[data-testid="dm-call-button"]')
  // Wait for call state to change
  await page.waitForSelector('[data-testid="call-overlay"], [data-testid="voice-connected"]', {
    timeout: 10_000,
  })
}

/** Accept an incoming call. */
export async function acceptIncomingCall(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="incoming-call"]', { timeout: 10_000 })
  await page.click('[data-testid="accept-call"]')
  await page.waitForSelector('[data-testid="call-overlay"], [data-testid="voice-connected"]', {
    timeout: 10_000,
  })
}

/** Reject an incoming call. */
export async function rejectIncomingCall(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="incoming-call"]', { timeout: 10_000 })
  await page.click('[data-testid="reject-call"]')
}

/** Disconnect from the current call. */
export async function disconnectCall(page: Page): Promise<void> {
  await page.click('[data-testid="disconnect-call"]')
  // Wait for call overlay to disappear
  await page.waitForSelector('[data-testid="call-overlay"]', {
    state: 'hidden',
    timeout: 10_000,
  })
}

/** Join a voice channel (click on it in sidebar). */
export async function joinVoiceChannel(page: Page, channelName: string): Promise<void> {
  await page.click(`.vesper-channel-row-voice:has-text("${channelName}")`)
  await page.waitForSelector('[data-testid="voice-channel-panel"]', { timeout: 15_000 })
}

/** Toggle mute in a voice call. */
export async function toggleMute(page: Page): Promise<void> {
  await page.click('[data-testid="mute-button"]')
}

/** Check if muted. */
export async function isMuted(page: Page): Promise<boolean> {
  const btn = page.locator('[data-testid="mute-button"]')
  const classes = await btn.getAttribute('class')
  return classes?.includes('muted') ?? false
}

/** Toggle camera in a voice call. */
export async function toggleCamera(page: Page): Promise<void> {
  await page.click('[data-testid="camera-button"]')
}

/** Check if local camera preview is showing. */
export async function hasLocalVideoPreview(page: Page): Promise<boolean> {
  return page.locator('[data-testid="local-video"]').isVisible()
}

/** Check if remote video is rendering for a participant. */
export async function hasRemoteVideo(page: Page, username: string): Promise<boolean> {
  return page.locator(`[data-testid="remote-video-${username}"]`).isVisible()
}

/** Get voice participant names. */
export async function getVoiceParticipants(page: Page): Promise<string[]> {
  const participants = page.locator('[data-testid="voice-participant-name"]')
  return participants.allTextContents()
}

/** Toggle screen share. */
export async function toggleScreenShare(page: Page): Promise<void> {
  await page.click('[data-testid="screen-share-button"]')
}

/** Check if screen share is active. */
export async function isScreenSharing(page: Page): Promise<boolean> {
  const btn = page.locator('[data-testid="screen-share-button"]')
  const classes = await btn.getAttribute('class')
  return classes?.includes('active') ?? false
}

/** Check if a remote screen share feed is visible. */
export async function hasRemoteScreenShare(page: Page): Promise<boolean> {
  return page.locator('[data-testid="remote-screen-share"]').isVisible()
}
