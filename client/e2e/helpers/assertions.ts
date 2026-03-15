/**
 * Cross-client state comparison and snapshot assertions.
 * Covers: R-ASSERT-1, R-ASSERT-2
 */

import { expect, type Page } from '@playwright/test'

export interface ChatSnapshot {
  messages: MessageSnapshot[]
  threadCounts: Record<string, number>
  reactions: Record<string, Record<string, number>>
  unreadBadges: Record<string, number>
  activeServer: string | null
  activeChannel: string | null
}

export interface MessageSnapshot {
  text: string
  sender: string
  hasThread: boolean
  isEdited: boolean
}

/** Capture a normalized snapshot of the visible chat state. */
export async function captureSnapshot(page: Page): Promise<ChatSnapshot> {
  return page.evaluate(() => {
    const messages: Array<{
      text: string
      sender: string
      hasThread: boolean
      isEdited: boolean
    }> = []
    const threadCounts: Record<string, number> = {}
    const reactions: Record<string, Record<string, number>> = {}

    const rows = document.querySelectorAll('[data-testid="message-row"]')
    rows.forEach((row) => {
      const content = row.querySelector('[data-testid="message-content"]')?.textContent || ''
      const sender = row.querySelector('[data-testid="message-sender"]')?.textContent || ''
      const threadBtn = row.querySelector('[data-testid="thread-count"]')
      const edited = row.querySelector('[data-testid="edited-marker"]') !== null
      const hasThread = threadBtn !== null

      messages.push({ text: content, sender, hasThread, isEdited: edited })

      if (threadBtn) {
        threadCounts[content] = parseInt(threadBtn.textContent || '0', 10)
      }

      const reactionChips = row.querySelectorAll('[data-testid="reaction-chip"]')
      if (reactionChips.length > 0) {
        const msgReactions: Record<string, number> = {}
        reactionChips.forEach((chip) => {
          const text = chip.textContent || ''
          const match = text.match(/(.+?)\s*(\d+)/)
          if (match) {
            msgReactions[match[1].trim()] = parseInt(match[2], 10)
          }
        })
        reactions[content] = msgReactions
      }
    })

    // Unread badges
    const unreadBadges: Record<string, number> = {}
    const badges = document.querySelectorAll('.vesper-channel-unread-badge')
    badges.forEach((badge) => {
      const label = badge.closest('.vesper-channel-row')?.querySelector('.vesper-channel-row-label')
      if (label) {
        unreadBadges[label.textContent || ''] = parseInt(badge.textContent || '0', 10)
      }
    })

    // Active server/channel
    const activeServerEl = document.querySelector(
      '[data-testid="sidebar"] .bg-accent.rounded-2xl[title]'
    )
    const activeChannelEl = document.querySelector(
      '.vesper-channel-row-active .vesper-channel-row-label'
    )

    return {
      messages,
      threadCounts,
      reactions,
      unreadBadges,
      activeServer: activeServerEl?.getAttribute('title') || null,
      activeChannel: activeChannelEl?.textContent || null,
    }
  })
}

/**
 * Assert that two clients have converged on the same visible state.
 * Covers: R-ASSERT-1 (exact cross-client state comparison)
 *         R-ASSERT-2 (fail on duplicates, gaps, stale counters)
 */
export async function assertConvergence(
  pageA: Page,
  pageB: Page,
  label = 'convergence'
): Promise<void> {
  const snapshotA = await captureSnapshot(pageA)
  const snapshotB = await captureSnapshot(pageB)

  // Compare message lists (sorted — async crypto may deliver in slightly different order)
  const textsA = snapshotA.messages.map((m) => m.text).sort()
  const textsB = snapshotB.messages.map((m) => m.text).sort()

  expect(textsA, `${label}: message list mismatch`).toEqual(textsB)

  // Check for duplicates
  const uniqueA = new Set(textsA)
  expect(uniqueA.size, `${label}: duplicate messages on client A`).toBe(textsA.length)
  const uniqueB = new Set(textsB)
  expect(uniqueB.size, `${label}: duplicate messages on client B`).toBe(textsB.length)

  // Compare thread counts
  expect(snapshotA.threadCounts, `${label}: thread counts differ`).toEqual(
    snapshotB.threadCounts
  )

  // Compare reactions
  expect(snapshotA.reactions, `${label}: reactions differ`).toEqual(snapshotB.reactions)
}

/**
 * Assert that three clients have converged on the same state.
 */
export async function assertThreeWayConvergence(
  pageA: Page,
  pageB: Page,
  pageC: Page,
  label = 'three-way convergence'
): Promise<void> {
  await assertConvergence(pageA, pageB, `${label} A-B`)
  await assertConvergence(pageB, pageC, `${label} B-C`)
}

/**
 * Assert that a message is NOT visible (was deleted or is thread-only).
 */
export async function assertMessageNotVisible(
  page: Page,
  text: string
): Promise<void> {
  const count = await page.locator(`[data-testid="message-row"]:has-text("${text}")`).count()
  expect(count, `Message "${text}" should not be visible`).toBe(0)
}

/**
 * Assert that a message IS visible.
 */
export async function assertMessageVisible(
  page: Page,
  text: string
): Promise<void> {
  await expect(
    page.locator(`[data-testid="message-row"]:has-text("${text}")`)
  ).toBeVisible()
}

/**
 * Assert no decryption failure messages are visible.
 * Covers: R-E2EE-1
 */
export async function assertNoDecryptionFailures(page: Page): Promise<void> {
  const failures = [
    'Message unavailable - decryption failed',
    'Message unavailable',
    'Approve this device to read encrypted messages.',
    'Conversation encryption is still syncing',
    'Encrypted message is syncing...',
    'File expired or unavailable',
  ]

  for (const text of failures) {
    const count = await page.locator(`text="${text}"`).count()
    expect(count, `Decryption failure visible: "${text}"`).toBe(0)
  }
}
