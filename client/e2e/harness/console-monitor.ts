/**
 * Console and network failure monitoring.
 * Covers: R-ASSERT-3 (known failure signatures fail the run)
 */

import type { Page, ConsoleMessage, Request } from '@playwright/test'

export interface ConsoleEntry {
  type: string
  text: string
  url: string
  timestamp: number
}

export interface NetworkFailure {
  url: string
  method: string
  status: number
  timestamp: number
}

/** Failure signatures that indicate real product bugs (R-E2EE-1, R-ASSERT-3). */
const FATAL_CONSOLE_PATTERNS = [
  'InvalidStateError: Invalid state',
  'ValidationError: Commit cannot contain an Add proposal for someone already in the group',
  'Message unavailable - decryption failed',
  'Message unavailable',
  'File expired or unavailable',
]

/** Noise we explicitly ignore. */
const IGNORED_PATTERNS = [
  'cloudflare',
  'beacon',
  'chrome-extension://',
  'favicon.ico',
  'DevTools',
  'Download the React DevTools',
  '[HMR]',
  'ERR_BLOCKED_BY_CLIENT',
  'epoch too old', // Expected after context restart / MLS group re-sync
  'Commit processing failed', // Expected during MLS recovery flows
]

export class ConsoleMonitor {
  private entries: ConsoleEntry[] = []
  private networkFailures: NetworkFailure[] = []
  private page: Page

  constructor(page: Page) {
    this.page = page
    this.attach()
  }

  private attach(): void {
    this.page.on('console', (msg: ConsoleMessage) => {
      const text = msg.text()
      if (IGNORED_PATTERNS.some((p) => text.includes(p))) return

      this.entries.push({
        type: msg.type(),
        text,
        url: this.page.url(),
        timestamp: Date.now(),
      })
    })

    this.page.on('requestfailed', (req: Request) => {
      const url = req.url()
      if (IGNORED_PATTERNS.some((p) => url.includes(p))) return

      this.networkFailures.push({
        url,
        method: req.method(),
        status: 0,
        timestamp: Date.now(),
      })
    })

    this.page.on('response', (res) => {
      const status = res.status()
      if (status >= 500) {
        this.networkFailures.push({
          url: res.url(),
          method: res.request().method(),
          status,
          timestamp: Date.now(),
        })
      }
    })
  }

  /** Returns fatal entries matching known product-relevant failure signatures. */
  getFatalEntries(): ConsoleEntry[] {
    return this.entries.filter((entry) =>
      FATAL_CONSOLE_PATTERNS.some((pattern) => entry.text.includes(pattern))
    )
  }

  /** Returns websocket connection failures (repeated disconnects). */
  getWebsocketFailures(): NetworkFailure[] {
    return this.networkFailures.filter((f) => f.url.includes('/socket'))
  }

  /** Returns all console errors (type=error). */
  getErrors(): ConsoleEntry[] {
    return this.entries.filter((e) => e.type === 'error')
  }

  getAllEntries(): ConsoleEntry[] {
    return [...this.entries]
  }

  getAllNetworkFailures(): NetworkFailure[] {
    return [...this.networkFailures]
  }

  /** Asserts no fatal failures occurred. Throws with detail if any did. */
  assertNoFatalFailures(): void {
    const fatal = this.getFatalEntries()
    if (fatal.length > 0) {
      const details = fatal.map((e) => `  [${e.type}] ${e.text}`).join('\n')
      throw new Error(`Fatal console failures detected:\n${details}`)
    }

    const wsFailures = this.getWebsocketFailures()
    if (wsFailures.length >= 3) {
      throw new Error(
        `Repeated websocket failures (${wsFailures.length}): ${wsFailures.map((f) => f.url).join(', ')}`
      )
    }
  }
}
