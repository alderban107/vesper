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
  apiPort: number
  apiUrl: string
  clientPort: number
  clientUrl: string
  dbName: string
  artifactDir: string
  profileDir: string
  phoenixPid?: number
  vitePid?: number
}

const STATE_FILE = path.join(os.tmpdir(), 'vesper-e2e-state.json')

export function writeRunState(state: RunState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

export function readRunState(): RunState {
  const raw = fs.readFileSync(STATE_FILE, 'utf-8')
  return JSON.parse(raw) as RunState
}

export function clearRunState(): void {
  try {
    fs.unlinkSync(STATE_FILE)
  } catch {
    // already removed
  }
}

export function generateRunId(): string {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 6)
  return `${ts}_${rand}`
}
