/**
 * Navigation helpers: refresh, reconnect, browser restart.
 * Covers: R-NAV-1, R-NAV-2, R-SYNC-1, R-SYNC-2, R-SYNC-4
 */

import type { Page, BrowserContext, Browser } from '@playwright/test'
import { readRunState } from '../harness/state'
import { waitForAppShell } from './wait'

/** Hard page refresh and wait for app shell. */
export async function hardRefresh(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'networkidle' })
  await waitForAppShell(page)
}

/**
 * Dump all IndexedDB databases from a page into a JSON-safe format.
 * Converts Uint8Array/ArrayBuffer values to base64-tagged objects so
 * they survive the CDP serialization round-trip.
 */
async function dumpIndexedDB(page: Page): Promise<IDBDump> {
  return page.evaluate(async () => {
    // Recursively convert binary values to base64-tagged objects
    function serializeValue(val: unknown): unknown {
      if (val instanceof Uint8Array) {
        let binary = ''
        for (let i = 0; i < val.length; i++) binary += String.fromCharCode(val[i])
        return { __idb_binary: true, b64: btoa(binary) }
      }
      if (val instanceof ArrayBuffer) {
        const bytes = new Uint8Array(val)
        let binary = ''
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
        return { __idb_binary: true, b64: btoa(binary) }
      }
      if (Array.isArray(val)) return val.map(serializeValue)
      if (val !== null && typeof val === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
          out[k] = serializeValue(v)
        }
        return out
      }
      return val
    }

    const databases = await indexedDB.databases()
    const dump: Array<{ name: string; version: number; stores: Record<string, unknown[]> }> = []

    for (const dbInfo of databases) {
      if (!dbInfo.name || !dbInfo.version) continue

      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbInfo.name!, dbInfo.version)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })

      const stores: Record<string, unknown[]> = {}
      for (const storeName of Array.from(db.objectStoreNames)) {
        const records = await new Promise<unknown[]>((resolve, reject) => {
          const t = db.transaction(storeName, 'readonly')
          const s = t.objectStore(storeName)
          const req = s.getAll()
          req.onsuccess = () => resolve(req.result as unknown[])
          req.onerror = () => reject(req.error)
        })
        stores[storeName] = records.map((r) => serializeValue(r))
      }

      dump.push({ name: dbInfo.name, version: dbInfo.version, stores })
      db.close()
    }

    return dump
  })
}

/**
 * Restore IndexedDB databases from a dump, converting base64-tagged
 * objects back to Uint8Array.
 */
async function restoreIndexedDB(page: Page, dump: IDBDump): Promise<void> {
  await page.evaluate(async (entries) => {
    // Recursively restore base64-tagged objects to Uint8Array
    function deserializeValue(val: unknown): unknown {
      if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
        const obj = val as Record<string, unknown>
        if (obj.__idb_binary === true && typeof obj.b64 === 'string') {
          const binary = atob(obj.b64)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
          return bytes
        }
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(obj)) {
          out[k] = deserializeValue(v)
        }
        return out
      }
      if (Array.isArray(val)) return val.map(deserializeValue)
      return val
    }

    for (const entry of entries) {
      // Open with the same version — the app will have already created the
      // schema during its initial load, so no onupgradeneeded is needed.
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(entry.name, entry.version)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })

      for (const [storeName, records] of Object.entries(entry.stores)) {
        if (!db.objectStoreNames.contains(storeName)) continue
        if ((records as unknown[]).length === 0) continue

        const t = db.transaction(storeName, 'readwrite')
        const s = t.objectStore(storeName)
        // Clear existing records first (app may have created new state)
        s.clear()
        for (const record of records as unknown[]) {
          s.put(deserializeValue(record))
        }
        await new Promise<void>((resolve, reject) => {
          t.oncomplete = () => resolve()
          t.onerror = () => reject(t.error)
        })
      }

      db.close()
    }
  }, dump)
}

type IDBDump = Array<{ name: string; version: number; stores: Record<string, unknown[]> }>

/** Close and reopen a browser context, returning a new page.
 *  Preserves both localStorage/cookies (via storageState) AND IndexedDB
 *  (via manual dump/restore) so MLS group state and decrypted message
 *  caches survive the restart.
 *  Covers: R-HARNESS-5 (persistent profiles within a run)
 */
export async function restartBrowserContext(
  browser: Browser,
  oldContext: BrowserContext
): Promise<{ context: BrowserContext; page: Page }> {
  const state = readRunState()

  // Get the active page for IndexedDB access
  const oldPage = oldContext.pages()[0]

  // Dump IndexedDB before closing (MLS groups, message cache, identity keys)
  const idbDump = await dumpIndexedDB(oldPage)

  // Capture storage state (cookies + localStorage)
  const storageState = await oldContext.storageState()

  await oldContext.close()

  // Create new context with the saved storage state
  const context = await browser.newContext({
    storageState,
  })

  const page = await context.newPage()
  await page.addInitScript(`window.VESPER_API_URL = '${state.apiUrl}'`)
  await page.goto(state.clientUrl)
  await waitForAppShell(page)

  // Restore IndexedDB (overwrites any state the fresh app created)
  await restoreIndexedDB(page, idbDump)

  // Reload so the app re-reads from the restored IndexedDB
  await page.reload({ waitUntil: 'networkidle' })
  await waitForAppShell(page)

  return { context, page }
}

/** Simulate websocket disconnect by navigating away and back. */
export async function simulateDisconnect(page: Page, durationMs = 3_000): Promise<void> {
  const state = readRunState()
  const currentUrl = page.url()

  // Navigate to a blank page to kill the socket
  await page.goto('about:blank')
  await page.waitForTimeout(durationMs)

  // Navigate back
  await page.goto(currentUrl || state.clientUrl)
  await waitForAppShell(page)
}

/** Force a reconnect by toggling offline mode briefly. */
export async function forceReconnect(page: Page): Promise<void> {
  const context = page.context()
  await context.setOffline(true)
  await page.waitForTimeout(2_000)
  await context.setOffline(false)
  await page.waitForTimeout(3_000) // allow reconnect + sync
}

/** Get the currently selected server name from the sidebar. */
export async function getActiveServerName(page: Page): Promise<string | null> {
  const active = page.locator('[data-testid="sidebar"] .bg-accent.rounded-2xl[title]')
  if (await active.count() === 0) return null
  return active.getAttribute('title')
}

/** Get the currently selected channel name. */
export async function getActiveChannelName(page: Page): Promise<string | null> {
  const active = page.locator('.vesper-channel-row-active .vesper-channel-row-label')
  if (await active.count() === 0) return null
  return active.textContent()
}

/** Check if the user is in the DM view (no server selected). */
export async function isInDmView(page: Page): Promise<boolean> {
  // DM view is indicated by the DM icon being active (bg-accent class)
  const dmButton = page.locator('[data-testid="sidebar"] button[title="Direct Messages"]')
  const classes = await dmButton.getAttribute('class')
  return classes?.includes('bg-accent') ?? false
}
