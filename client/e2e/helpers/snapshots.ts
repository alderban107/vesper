/**
 * State snapshot recording at key checkpoints.
 * Covers: R-ASSERT-4
 */

import fs from 'fs'
import path from 'path'
import { readRunState } from '../harness/state'
import { captureSnapshot, type ChatSnapshot } from './assertions'
import type { Page } from '@playwright/test'

export interface CheckpointSnapshot {
  checkpoint: string
  client: string
  timestamp: number
  snapshot: ChatSnapshot
  url: string
}

const snapshots: CheckpointSnapshot[] = []

/** Record a snapshot for a client at a named checkpoint. */
export async function recordSnapshot(
  page: Page,
  checkpoint: string,
  clientName: string
): Promise<void> {
  const snapshot = await captureSnapshot(page)
  const entry: CheckpointSnapshot = {
    checkpoint,
    client: clientName,
    timestamp: Date.now(),
    snapshot,
    url: page.url(),
  }
  snapshots.push(entry)
}

/** Write all recorded snapshots to the artifacts directory. */
export function writeSnapshots(): void {
  try {
    const state = readRunState()
    const outPath = path.join(state.artifactDir, 'snapshots.json')
    fs.writeFileSync(outPath, JSON.stringify(snapshots, null, 2))
  } catch {
    // artifact dir may not exist if setup failed
  }
}

/** Get all recorded snapshots. */
export function getSnapshots(): CheckpointSnapshot[] {
  return [...snapshots]
}
