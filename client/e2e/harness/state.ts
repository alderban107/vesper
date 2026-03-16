/**
 * Shared state between global-setup, tests, and global-teardown.
 * Written to a temp file so the Playwright worker processes can read it.
 * Covers: R-HARNESS-1, R-HARNESS-2
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

export interface RunState {
  runId: string
  ownerPid?: number
  apiPort: number
  apiUrl: string
  clientPort: number
  clientUrl: string
  dbName: string
  artifactDir: string
  profileDir: string
  phoenixPid?: number
  vitePid?: number
  /** Recovery keys captured during signup, keyed by username. */
  recoveryKeys?: Record<string, string>
}

const STATE_FILE = path.join(os.tmpdir(), 'vesper-e2e-state.json')
const BACKUP_STATE_FILE = path.resolve(__dirname, '..', 'artifacts', '.run-state.json')
let cachedState: RunState | null = null

export function writeRunState(state: RunState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  fs.mkdirSync(path.dirname(BACKUP_STATE_FILE), { recursive: true })
  fs.writeFileSync(BACKUP_STATE_FILE, JSON.stringify(state, null, 2))
  cachedState = state
}

export function readRunState(): RunState {
  for (const candidate of [STATE_FILE, BACKUP_STATE_FILE]) {
    try {
      const raw = fs.readFileSync(candidate, 'utf-8')
      cachedState = JSON.parse(raw) as RunState
      return cachedState
    } catch {
      // try next location
    }
  }

  if (cachedState) {
    return cachedState
  }

  throw new Error(`Run state file missing at ${STATE_FILE} and ${BACKUP_STATE_FILE}`)
}

export function clearRunState(): void {
  cachedState = null
  for (const candidate of [STATE_FILE, BACKUP_STATE_FILE]) {
    try {
      fs.unlinkSync(candidate)
    } catch {
      // already removed
    }
  }
}

/** Persist a recovery key for later test tiers to read. */
export function saveRecoveryKey(username: string, key: string): void {
  const state = readRunState()
  state.recoveryKeys = { ...state.recoveryKeys, [username]: key }
  writeRunState(state)
}

/** Read a recovery key saved by a prior test tier. */
export function getRecoveryKey(username: string): string {
  const state = readRunState()
  const key = state.recoveryKeys?.[username]
  if (!key) throw new Error(`No recovery key found for ${username}. Was P0 signup run first?`)
  return key
}

export function generateRunId(): string {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 6)
  return `${ts}_${rand}`
}
