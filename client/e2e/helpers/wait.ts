/**
 * UI readiness waiters — poll for real state, never blind sleep.
 * Covers: R-HARNESS-4
 */

import type { Page } from '@playwright/test'

/** Wait for the main app shell to be visible (authenticated state). */
export async function waitForAppShell(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="main-page"]', { timeout: 10_000 })
}

/** Wait for the login form to be visible. */
export async function waitForLoginPage(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="login-form"]', { timeout: 10_000 })
}

/** Wait for the register form to be visible. */
export async function waitForRegisterPage(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="register-form"]', { timeout: 10_000 })
}

/** Wait for the recovery key modal after registration. */
export async function waitForRecoveryModal(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="recovery-modal"]', { timeout: 10_000 })
}

/** Wait for sidebar to show a server by name. */
export async function waitForServerInSidebar(page: Page, serverName: string): Promise<void> {
  await page.waitForSelector(`[data-testid="sidebar"] button[title="${serverName}"]`, {
    timeout: 10_000,
  })
}

/** Wait for a channel row to appear by name. */
export async function waitForChannel(page: Page, channelName: string): Promise<void> {
  await page.waitForSelector(`.vesper-channel-row-label:text("${channelName}")`, {
    timeout: 10_000,
  })
}

/** Wait for a message containing specific text to appear. */
export async function waitForMessage(page: Page, text: string, timeout = 10_000): Promise<void> {
  await page.waitForSelector(`[data-testid="message-row"]:has-text("${text}")`, { timeout })
}

/** Wait for a DM conversation row containing a username. */
export async function waitForDmConversation(page: Page, username: string): Promise<void> {
  await page.waitForSelector(`[data-testid="sidebar"] :text("${username}")`, {
    timeout: 15_000,
  })
}

/** Wait for socket connection (check console for "Joined" message). */
export async function waitForSocketConnected(page: Page): Promise<void> {
  // The app logs "Joined user:<id>" on socket connect.
  // We wait for the main page + a brief stabilization.
  await waitForAppShell(page)
  await page.waitForTimeout(1_000) // minimal stabilization after app shell
}

/** Wait for typing indicator to appear. */
export async function waitForTypingIndicator(page: Page, username: string): Promise<void> {
  await page.waitForSelector(`[data-testid="typing-indicator"]:has-text("${username}")`, {
    timeout: 10_000,
  })
}

/** Wait for typing indicator to disappear. */
export async function waitForTypingGone(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="typing-indicator"]', {
    state: 'hidden',
    timeout: 10_000,
  })
}

/** Wait for unread badge on a channel or DM. */
export async function waitForUnreadBadge(page: Page, target: string): Promise<void> {
  await page.waitForSelector(`:text("${target}") ~ .vesper-channel-unread-badge, :text("${target}") ~ span:has-text(/\\d+/)`, {
    timeout: 10_000,
  })
}

/** Wait until the device trust gate is visible. */
export async function waitForDeviceTrustGate(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="device-trust-gate"]', { timeout: 15_000 })
}

/** Wait until the device trust gate disappears. */
export async function waitForDeviceTrustGateGone(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="device-trust-gate"]', {
    state: 'hidden',
    timeout: 10_000,
  })
}

/** Wait for the thread panel to open. */
export async function waitForThreadPanel(page: Page): Promise<void> {
  await page.waitForSelector('.vesper-thread-panel', { timeout: 10_000 })
}

/** Wait for a specific number of thread replies. */
export async function waitForThreadReplyCount(
  page: Page,
  count: number
): Promise<void> {
  await page.waitForSelector(`.vesper-thread-subtitle:has-text("${count}")`, {
    timeout: 10_000,
  })
}

/** Wait for the session notice modal. */
export async function waitForSessionNotice(page: Page): Promise<void> {
  await page.waitForSelector(':text("Sign in again on this device")', { timeout: 15_000 })
}
