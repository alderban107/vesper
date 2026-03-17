/**
 * Voice and video call helpers.
 * Covers: R-VOICE-1, R-VOICE-2, R-VOICE-3, R-VOICE-4, R-VOICE-5
 * Covers: R-HARNESS-7 (deterministic fake media)
 */

import { expect, type Page } from '@playwright/test'

async function countVisible(locator: ReturnType<Page['locator']>): Promise<number> {
  return locator.evaluateAll((elements) =>
    elements.filter((element) => {
      if (!(element instanceof HTMLElement)) {
        return false
      }

      const style = window.getComputedStyle(element)
      if (style.visibility === 'hidden' || style.display === 'none') {
        return false
      }

      return element.getClientRects().length > 0
    }).length,
  )
}

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
  // Wait for the connected call UI to disappear for either DM or channel voice.
  await Promise.race([
    page.waitForSelector('[data-testid="call-overlay"]', { state: 'hidden', timeout: 10_000 }).catch(() => {}),
    page.waitForSelector('[data-testid="voice-connected"]', { state: 'detached', timeout: 10_000 }).catch(() => {}),
  ])
}

/** Join a voice channel (click on it in sidebar). */
export async function joinVoiceChannel(page: Page, channelName: string): Promise<void> {
  await page.click(`.vesper-channel-row-voice:has-text("${channelName}")`)
  await page.waitForSelector('[data-testid="voice-channel-panel"]', { timeout: 15_000 })
  await page.waitForSelector('[data-testid="disconnect-call"]', { timeout: 15_000 })
}

/** Toggle mute in a voice call. */
export async function toggleMute(page: Page): Promise<void> {
  await page.click('[data-testid="mute-button"]')
}

/** Check if muted. */
export async function isMuted(page: Page): Promise<boolean> {
  const btn = page.locator('[data-testid="mute-button"]')
  const classes = await btn.getAttribute('class')
  return (classes?.includes('vesper-call-overlay-control-danger') || classes?.includes('vesper-voice-room-button-danger')) ?? false
}

/** Toggle camera in a voice call. */
export async function toggleCamera(page: Page): Promise<void> {
  await page.click('[data-testid="camera-button"]')
}

/** Check if local camera preview is showing. */
export async function hasLocalVideoPreview(page: Page): Promise<boolean> {
  return (await countVisible(page.locator('[data-testid="local-video"]'))) > 0
}

/** Wait for the local camera preview to reach the requested visibility state. */
export async function waitForLocalVideoPreview(
  page: Page,
  visible: boolean,
  timeout = 15_000,
): Promise<void> {
  await expect
    .poll(async () => hasLocalVideoPreview(page), { timeout })
    .toBe(visible)
}

/** Check if remote video is rendering for a participant. */
export async function hasRemoteVideo(page: Page, username: string): Promise<boolean> {
  return (await countVisible(page.locator(`[data-testid="remote-video-${username}"]`))) > 0
}

/** Wait for a participant's remote video to reach the requested visibility state. */
export async function waitForRemoteVideo(
  page: Page,
  username: string,
  visible: boolean,
  timeout = 15_000,
): Promise<void> {
  await expect
    .poll(async () => hasRemoteVideo(page, username), { timeout })
    .toBe(visible)
}

/** Get voice participant names. */
export async function getVoiceParticipants(page: Page): Promise<string[]> {
  const participants = page.locator('[data-testid="voice-participant-name"]')
  return participants.allTextContents()
}

/** Wait until the voice roster reaches the requested visible participant count. */
export async function waitForVoiceParticipants(
  page: Page,
  minimumCount: number,
  timeout = 15_000,
): Promise<string[]> {
  const participants = page.locator('[data-testid="voice-participant-name"]')

  await expect
    .poll(
      async () => countVisible(participants),
      { timeout },
    )
    .toBeGreaterThanOrEqual(minimumCount)

  return participants.allTextContents()
}

/** Toggle screen share. */
export async function toggleScreenShare(page: Page): Promise<void> {
  await page.locator('[data-testid="screen-share-button"]:visible').first().click()
}

/** Check if screen share is active. */
export async function isScreenSharing(page: Page): Promise<boolean> {
  const accountPanelStop = page.locator('button[title="Stop Screen Share"]:visible')
  if ((await accountPanelStop.count()) > 0) {
    return true
  }

  const stopByTitle = page.locator('[data-testid="screen-share-button"][title="Stop Screen Share"]:visible')
  if ((await stopByTitle.count()) > 0) {
    return true
  }

  const stopByLabel = page.locator('[data-testid="screen-share-button"]:visible').filter({
    hasText: 'Stop Share'
  })
  if ((await stopByLabel.count()) > 0) {
    return true
  }

  const activeButton = page.locator(
    '[data-testid="screen-share-button"].vesper-call-overlay-control-active:visible, [data-testid="screen-share-button"].vesper-voice-room-button-active:visible'
  )
  return (await activeButton.count()) > 0
}

/** Check if a remote screen share feed is visible. */
export async function hasRemoteScreenShare(page: Page): Promise<boolean> {
  return page.locator('[data-testid="remote-screen-share"]').isVisible()
}
