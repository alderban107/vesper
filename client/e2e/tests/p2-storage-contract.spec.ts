import { expect, test, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readRunState } from '../harness/state'

const REPO_ROOT = path.resolve(__dirname, '../../..')

const intent = {
  version: 1 as const,
  operation: 'mls_history_bundle',
  idempotency_key: 'storage-contract-history',
  scope_id: 'storage-contract-scope',
  membership_generation: 7,
  payload_json: '{"request_id":"storage-contract-history"}',
  attempts: 1,
  state: 'accepted',
  result_json: '{"bundle_id":"storage-contract-bundle"}',
  created_at: '2026-07-15T00:00:00.000Z',
  updated_at: '2026-07-15T00:00:01.000Z'
}

const checkpoint = {
  state: null,
  epoch: 0,
  last_event_seq: 11,
  recent_commit_fingerprints: ['commit-fingerprint'],
  recent_history_bundle_fingerprints: ['history-fingerprint'],
  repair_status: null,
  repair_failure_count: 0,
  repair_last_error: null,
  repair_updated_at: null,
  control_intents: [intent]
}

test('IndexedDB adapter preserves the checkpoint control journal', async ({ page }) => {
  const { clientUrl } = readRunState()
  await page.goto(clientUrl)

  const sdkModulePath = path.resolve(REPO_ROOT, 'sdk/src/crypto/indexedDbStorage.ts')
  const moduleUrl = `/@fs${sdkModulePath}`
  const result = await page.evaluate(
    async ({ moduleUrl, checkpoint }) => {
      const { createIndexedDbAdapter } = await import(moduleUrl)
      const adapter = createIndexedDbAdapter(`storage-contract-${crypto.randomUUID()}`)
      await adapter.setScopeCheckpoint('storage-contract-scope', checkpoint)
      const loaded = await adapter.getScopeCheckpoint('storage-contract-scope')
      await adapter.deleteGroupState('storage-contract-scope')
      const afterDelete = await adapter.getScopeCheckpoint('storage-contract-scope')
      return { loaded, afterDelete }
    },
    { moduleUrl, checkpoint }
  )

  expect(result.loaded.last_event_seq).toBe(11)
  expect(result.loaded.control_intents).toEqual([intent])
  expect(result.afterDelete.last_event_seq).toBe(11)
  expect(result.afterDelete.control_intents).toEqual([])
})

test('Electron SQLite adapter preserves the checkpoint control journal', async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'vesper-electron-storage-'))
  const executable = path.resolve(REPO_ROOT, 'client/out/main/index.js')
  const electronExecutablePath = path.resolve(
    REPO_ROOT,
    process.platform === 'darwin'
      ? 'client/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
      : process.platform === 'win32'
        ? 'client/node_modules/electron/dist/electron.exe'
        : 'client/node_modules/electron/dist/electron'
  )
  const app = await electron.launch({
    executablePath: electronExecutablePath,
    args: [executable, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      NODE_ENV: 'production'
    }
  })

  try {
    const window = await app.firstWindow()
    const result = await window.evaluate(async ({ checkpoint }) => {
      await window.cryptoDb.setScopeCheckpoint('storage-contract-scope', checkpoint)
      const loaded = await window.cryptoDb.getScopeCheckpoint('storage-contract-scope')
      await window.cryptoDb.deleteGroupState('storage-contract-scope')
      const afterDelete = await window.cryptoDb.getScopeCheckpoint('storage-contract-scope')
      return { loaded, afterDelete }
    }, { checkpoint })

    expect(result.loaded.last_event_seq).toBe(11)
    expect(result.loaded.control_intents).toEqual([intent])
    expect(result.afterDelete.last_event_seq).toBe(11)
    expect(result.afterDelete.control_intents).toEqual([])
  } finally {
    await app.close()
    await rm(userDataDir, { recursive: true, force: true })
  }
})
