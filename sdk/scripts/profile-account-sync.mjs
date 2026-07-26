#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

import {
  bootServerStack,
  createDeviceHarness,
  teardownServerStack
} from '../dist/testing/index.js'
import { FileCryptoStorage } from '../dist/storage/file.js'
import { MemoryStorage } from '../dist/storage/index.js'

const SDK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = path.resolve(SDK_ROOT, '..')
const SERVER_ROOT = path.join(REPO_ROOT, 'server')
const DAY_MS = 86_400_000

function readPositiveInt(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? String(fallback), 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function readNonNegativeInt(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? String(fallback), 10)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return parsed
}

function readConfig() {
  const smoke = process.argv.includes('--smoke')
  const profileName = smoke ? 'smoke' : 'full'

  return {
    profileName,
    servers: readPositiveInt('ACCOUNT_PROFILE_SERVERS', smoke ? 5 : 250),
    directDms: readNonNegativeInt('ACCOUNT_PROFILE_DIRECT_DMS', smoke ? 200 : 50_000),
    groupDms: readNonNegativeInt('ACCOUNT_PROFILE_GROUP_DMS', smoke ? 20 : 5_000),
    peers: readPositiveInt('ACCOUNT_PROFILE_PEERS', smoke ? 20 : 500),
    activeDms: readNonNegativeInt('ACCOUNT_PROFILE_ACTIVE_DMS', smoke ? 20 : 100),
    pageSize: readPositiveInt('ACCOUNT_PROFILE_PAGE_SIZE', smoke ? 25 : 100),
    deltaChanges: readPositiveInt('ACCOUNT_PROFILE_DELTA_CHANGES', smoke ? 20 : 100),
    unrelatedChanges: readNonNegativeInt(
      'ACCOUNT_PROFILE_UNRELATED_CHANGES',
      smoke ? 200 : 10_000
    ),
    network: {
      roundTripLatencyMs: readNonNegativeInt('ACCOUNT_PROFILE_NETWORK_RTT_MS', 0),
      bandwidthKbps: readNonNegativeInt('ACCOUNT_PROFILE_BANDWIDTH_KBPS', 0)
    },
    budgets: {
      coldSnapshotMs: readPositiveInt('ACCOUNT_PROFILE_BUDGET_COLD_MS', 250),
      coldResponseBytes: readPositiveInt('ACCOUNT_PROFILE_BUDGET_COLD_BYTES', 262_144),
      warmCachedRenderMs: readPositiveInt('ACCOUNT_PROFILE_BUDGET_WARM_RENDER_MS', 50),
      noChangeDeltaMs: readPositiveInt('ACCOUNT_PROFILE_BUDGET_NO_CHANGE_MS', 50),
      noChangeResponseBytes: readPositiveInt(
        'ACCOUNT_PROFILE_BUDGET_NO_CHANGE_BYTES',
        2_048
      ),
      changedDeltaMs: readPositiveInt('ACCOUNT_PROFILE_BUDGET_CHANGED_DELTA_MS', 150),
      changedDeltaResponseBytes: readPositiveInt(
        'ACCOUNT_PROFILE_BUDGET_CHANGED_DELTA_BYTES',
        262_144
      ),
      workspaceSnapshotBytes: readPositiveInt(
        'ACCOUNT_PROFILE_BUDGET_WORKSPACE_BYTES',
        524_288
      ),
      dmPageSqlMs: readPositiveInt('ACCOUNT_PROFILE_BUDGET_DM_SQL_MS', 50),
      dmPageSharedBlocks: readPositiveInt('ACCOUNT_PROFILE_BUDGET_DM_SHARED_BLOCKS', 30_000),
      scopeDeltaSqlMs: readPositiveInt('ACCOUNT_PROFILE_BUDGET_DELTA_SQL_MS', 25),
      scopeDeltaSharedBlocks: readPositiveInt(
        'ACCOUNT_PROFILE_BUDGET_DELTA_SHARED_BLOCKS',
        250_000
      )
    },
    enforceBudgets: process.env.ACCOUNT_PROFILE_ENFORCE_BUDGETS !== '0',
    jsonOutputPath:
      process.env.ACCOUNT_PROFILE_JSON_OUTPUT ??
      path.join(SDK_ROOT, 'artifacts', `account-sync-profile-${profileName}.json`),
    keepStack: process.env.ACCOUNT_PROFILE_KEEP_STACK === '1'
  }
}

function byteLength(value) {
  if (value == null) return 0
  if (typeof value === 'string') return Buffer.byteLength(value)
  if (value instanceof ArrayBuffer) return value.byteLength
  if (ArrayBuffer.isView(value)) return value.byteLength
  if (value instanceof URLSearchParams) return Buffer.byteLength(value.toString())
  return 0
}

function routeFor(url) {
  const parsed = new URL(url)
  return `${parsed.pathname}${parsed.search}`
}

function createFetchMeter(network = { roundTripLatencyMs: 0, bandwidthKbps: 0 }) {
  let calls = []
  let syncGate = null

  return {
    fetchImpl: async (input, init = {}) => {
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url
      const route = routeFor(url)

      if (syncGate && new URL(url).pathname === '/api/v1/sync') {
        await syncGate.promise
        syncGate = null
      }

      const startedAt = performance.now()
      const response = await fetch(input, init)
      const responseBytes = (await response.clone().arrayBuffer()).byteLength
      const bandwidthDelayMs =
        network.bandwidthKbps > 0 ? (responseBytes * 8) / network.bandwidthKbps : 0
      const simulatedDelayMs = network.roundTripLatencyMs + bandwidthDelayMs
      if (simulatedDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, simulatedDelayMs))
      }
      const durationMs = performance.now() - startedAt
      let responseFull = false

      if (new URL(url).pathname === '/api/v1/sync') {
        try {
          const payload = await response.clone().json()
          responseFull = payload?.full === true
        } catch {
          responseFull = false
        }
      }

      calls.push({
        method: init.method ?? (typeof input === 'object' && input && 'method' in input ? input.method : 'GET'),
        route,
        requestBodyBytes: byteLength(init.body),
        responseBytes,
        durationMs,
        responseFull
      })
      return response
    },
    reset() {
      calls = []
    },
    blockNextWorkspaceSync() {
      let release
      const promise = new Promise((resolve) => {
        release = resolve
      })
      syncGate = { promise, release }
      return () => syncGate?.release()
    },
    snapshot() {
      return {
        callCount: calls.length,
        requestBodyBytes: calls.reduce((total, call) => total + call.requestBodyBytes, 0),
        responseBytes: calls.reduce((total, call) => total + call.responseBytes, 0),
        fullSyncResponses: calls.filter((call) => call.responseFull).length,
        calls: calls.map((call) => ({ ...call }))
      }
    }
  }
}

function memorySnapshot() {
  if (typeof global.gc === 'function') {
    global.gc()
  }
  const usage = process.memoryUsage()
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers
  }
}

function memoryDelta(before, after) {
  return Object.fromEntries(
    Object.keys(after).map((key) => [key, after[key] - before[key]])
  )
}

async function measureScenario(name, meter, operation, extra = async () => ({})) {
  meter.reset()
  const memoryBefore = memorySnapshot()
  const startedAt = performance.now()
  const value = await operation()
  const durationMs = performance.now() - startedAt
  const memoryAfter = memorySnapshot()

  return {
    name,
    durationMs,
    network: meter.snapshot(),
    memoryBefore,
    memoryAfter,
    memoryDelta: memoryDelta(memoryBefore, memoryAfter),
    ...(await extra(value))
  }
}

async function waitFor(description, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

function stackEnvironment(stack, extra = {}) {
  return {
    ...process.env,
    MIX_ENV: 'test',
    MIX_TEST_PARTITION: `_sdk_${stack.runId}`,
    VESPER_E2E: '1',
    TEST_DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1',
    TEST_DB_PORT: process.env.TEST_DB_PORT ?? '55432',
    TEST_DB_USER: process.env.TEST_DB_USER ?? 'vesper_sdk',
    TEST_DB_PASS: process.env.TEST_DB_PASS ?? 'vesper_sdk',
    ...extra
  }
}

function runFixtureScript(stack, config, userId, fixturePath, action) {
  execFileSync('mix', ['run', 'scripts/profile_account_fixture.exs'], {
    cwd: SERVER_ROOT,
    env: stackEnvironment(stack, {
      ACCOUNT_PROFILE_ACTION: action,
      ACCOUNT_PROFILE_USER_ID: userId,
      ACCOUNT_PROFILE_FIXTURE_PATH: fixturePath,
      ACCOUNT_PROFILE_SERVERS: String(config.servers),
      ACCOUNT_PROFILE_DIRECT_DMS: String(config.directDms),
      ACCOUNT_PROFILE_GROUP_DMS: String(config.groupDms),
      ACCOUNT_PROFILE_PEERS: String(config.peers),
      ACCOUNT_PROFILE_ACTIVE_DMS: String(config.activeDms),
      ACCOUNT_PROFILE_DELTA_CHANGES: String(config.deltaChanges),
      ACCOUNT_PROFILE_UNRELATED_CHANGES: String(config.unrelatedChanges)
    }),
    stdio: 'inherit'
  })
}

function psqlJson(stack, sql, variables = {}) {
  const args = [
    '-h', process.env.TEST_DB_HOST ?? '127.0.0.1',
    '-p', process.env.TEST_DB_PORT ?? '55432',
    '-U', process.env.TEST_DB_USER ?? 'vesper_sdk',
    '-d', stack.dbName,
    '-X', '-q', '-t', '-A'
  ]

  for (const [key, value] of Object.entries(variables)) {
    args.push('-v', `${key}=${value}`)
  }

  const output = execFileSync('psql', args, {
    env: {
      ...process.env,
      PGPASSWORD: process.env.TEST_DB_PASS ?? 'vesper_sdk'
    },
    input: sql,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit']
  }).trim()

  return JSON.parse(output)
}

function summarizePlan(explain) {
  const root = explain[0]
  const totals = {
    planningTimeMs: root['Planning Time'] ?? null,
    executionTimeMs: root['Execution Time'] ?? null,
    sharedHitBlocks: 0,
    sharedReadBlocks: 0,
    tempReadBlocks: 0,
    tempWrittenBlocks: 0,
    scannedRows: 0,
    rowsRemovedByFilter: 0,
    heapFetches: 0,
    indexProbeLoops: 0,
    planRows: root.Plan?.['Plan Rows'] ?? null,
    actualRows: root.Plan?.['Actual Rows'] ?? null,
    nodes: []
  }

  function walk(node) {
    if (!node) return
    totals.sharedHitBlocks += node['Shared Hit Blocks'] ?? 0
    totals.sharedReadBlocks += node['Shared Read Blocks'] ?? 0
    totals.tempReadBlocks += node['Temp Read Blocks'] ?? 0
    totals.tempWrittenBlocks += node['Temp Written Blocks'] ?? 0
    totals.rowsRemovedByFilter +=
      (node['Rows Removed by Filter'] ?? 0) * (node['Actual Loops'] ?? 1)
    totals.heapFetches += node['Heap Fetches'] ?? 0
    if (String(node['Node Type'] ?? '').includes('Scan')) {
      totals.scannedRows += (node['Actual Rows'] ?? 0) * (node['Actual Loops'] ?? 1)
    }
    if (String(node['Node Type'] ?? '').includes('Index')) {
      totals.indexProbeLoops += node['Actual Loops'] ?? 0
    }
    totals.nodes.push({
      nodeType: node['Node Type'],
      relationName: node['Relation Name'] ?? null,
      indexName: node['Index Name'] ?? null,
      actualRows: node['Actual Rows'] ?? null,
      loops: node['Actual Loops'] ?? null,
      rowsRemovedByFilter: node['Rows Removed by Filter'] ?? 0
    })
    for (const child of node.Plans ?? []) walk(child)
  }

  walk(root.Plan)
  return totals
}

function profileDatabase(stack, userId, pageSize) {
  const variables = { profile_user_id: userId, profile_limit: pageSize + 1 }
  const dmPage = psqlJson(stack, `
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
WITH user_conversations AS MATERIALIZED (
  SELECT p.conversation_id
  FROM dm_participants p
  WHERE p.user_id = :'profile_user_id'
)
SELECT r.conversation_id, r.activity_at
FROM user_conversations p
JOIN rooms r ON r.conversation_id = p.conversation_id
WHERE r.kind = 'dm'
ORDER BY r.activity_at DESC, r.conversation_id DESC
LIMIT :profile_limit;
`, variables)

  const servers = psqlJson(stack, `
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT s.id, s.name, s.icon_url, s.owner_id, s.inserted_at, s.updated_at
FROM servers s
JOIN memberships m ON m.server_id = s.id
WHERE m.user_id = :'profile_user_id'
ORDER BY s.inserted_at ASC;
`, variables)

  const scopeDelta = psqlJson(stack, `
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT events.*
FROM (
  SELECT * FROM (
    SELECT e.id, e.event_type, e.scope_kind, e.scope_id, e.payload, e.inserted_at
    FROM scope_sync_events e
    JOIN memberships m ON m.user_id = :'profile_user_id' AND m.server_id = e.scope_id
    WHERE e.scope_kind = 'server'
    ORDER BY e.id ASC
    LIMIT :profile_limit
  ) server_events
  UNION ALL
  SELECT * FROM (
    SELECT e.id, e.event_type, e.scope_kind, e.scope_id, e.payload, e.inserted_at
    FROM scope_sync_events e
    JOIN channels c ON c.id = e.scope_id
    JOIN memberships m ON m.user_id = :'profile_user_id' AND m.server_id = c.server_id
    WHERE e.scope_kind = 'channel'
    ORDER BY e.id ASC
    LIMIT :profile_limit
  ) channel_events
  UNION ALL
  SELECT * FROM (
    SELECT e.id, e.event_type, e.scope_kind, e.scope_id, e.payload, e.inserted_at
    FROM scope_sync_events e
    JOIN dm_participants p ON p.user_id = :'profile_user_id' AND p.conversation_id = e.scope_id
    WHERE e.scope_kind = 'dm'
    ORDER BY e.id ASC
    LIMIT :profile_limit
  ) dm_events
) events
ORDER BY events.id ASC
LIMIT :profile_limit;
`, variables)

  return {
    dmPage: { summary: summarizePlan(dmPage), explain: dmPage },
    servers: { summary: summarizePlan(servers), explain: servers },
    scopeDelta: { summary: summarizePlan(scopeDelta), explain: scopeDelta }
  }
}

function workspaceSnapshotBytes(storage, userId) {
  return storage.getWorkspaceSnapshot(userId).then((snapshot) => {
    if (!snapshot) return 0
    return Buffer.byteLength(snapshot.servers_json) +
      Buffer.byteLength(snapshot.conversations_json) +
      Buffer.byteLength(snapshot.unread_counts_json) +
      Buffer.byteLength(snapshot.token ?? '')
  })
}

function ageCursor(token) {
  const payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
  const expiredAt = new Date(Date.now() - 8 * DAY_MS)

  if (Array.isArray(payload)) {
    payload[1] = Math.floor(expiredAt.getTime() / 1000)
  } else {
    payload.synced_at = expiredAt.toISOString()
  }

  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

function assertWorkspace(state, config, expectedConversationCount) {
  if (state.servers.length !== config.servers) {
    throw new Error(`Expected ${config.servers} servers, received ${state.servers.length}`)
  }
  if (state.conversations.length !== expectedConversationCount) {
    throw new Error(
      `Expected ${expectedConversationCount} conversations, received ${state.conversations.length}`
    )
  }
  if (new Set(state.conversations.map((conversation) => conversation.id)).size !== state.conversations.length) {
    throw new Error('Workspace contains duplicate conversations')
  }
  if (!state.syncToken) {
    throw new Error('Workspace sync did not persist a cursor')
  }
}

async function approveSecondary(primary, secondary, username, password) {
  const session = await secondary.login(username, password)
  if (session.currentDevice?.trust_state !== 'pending') {
    throw new Error('Secondary profile device was not pending approval')
  }

  const pending = await waitFor('secondary profile device approval visibility', async () => {
    const devices = await primary.fetchDevices()
    return devices.devices.find((device) => device.client_id === secondary.deviceIdentity.id) ?? null
  })
  await primary.approveDevice(pending.id)

  await waitFor('secondary profile device trust', async () => {
    const devices = await secondary.fetchDevices()
    return devices.currentDevice?.trust_state === 'trusted'
  })
  await secondary.unlockTrustedDevice(password)
}

function evaluateBudgets(config, scenarios, database) {
  const byName = new Map(scenarios.map((scenario) => [scenario.name, scenario]))
  const checks = []

  function check(name, actual, maximum, unit) {
    const passed = typeof actual === 'number' && actual <= maximum
    checks.push({ name, actual, maximum, unit, passed })
  }

  const cold = byName.get('cold_compact_snapshot')
  const warm = byName.get('warm_cached_restart')
  const noChange = byName.get('no_change_delta')
  const changed = byName.get('bounded_delta_with_unrelated_traffic')

  check('cold compact snapshot latency', cold?.durationMs, config.budgets.coldSnapshotMs, 'ms')
  check(
    'cold compact snapshot response',
    cold?.network.responseBytes,
    config.budgets.coldResponseBytes,
    'bytes'
  )
  check(
    'warm cached render latency',
    warm?.cachedRenderMs,
    config.budgets.warmCachedRenderMs,
    'ms'
  )
  check('no-change delta latency', noChange?.durationMs, config.budgets.noChangeDeltaMs, 'ms')
  check(
    'no-change delta response',
    noChange?.network.responseBytes,
    config.budgets.noChangeResponseBytes,
    'bytes'
  )
  check('changed delta latency', changed?.durationMs, config.budgets.changedDeltaMs, 'ms')
  check(
    'changed delta response',
    changed?.network.responseBytes,
    config.budgets.changedDeltaResponseBytes,
    'bytes'
  )
  check(
    'workspace snapshot size',
    cold?.workspaceSnapshotBytes,
    config.budgets.workspaceSnapshotBytes,
    'bytes'
  )
  check(
    'DM page SQL latency',
    database.dmPage.summary.executionTimeMs,
    config.budgets.dmPageSqlMs,
    'ms'
  )
  check(
    'DM page shared buffers',
    database.dmPage.summary.sharedHitBlocks,
    config.budgets.dmPageSharedBlocks,
    'blocks'
  )
  check(
    'scope delta SQL latency',
    database.scopeDelta.summary.executionTimeMs,
    config.budgets.scopeDeltaSqlMs,
    'ms'
  )
  check(
    'scope delta shared buffers',
    database.scopeDelta.summary.sharedHitBlocks,
    config.budgets.scopeDeltaSharedBlocks,
    'blocks'
  )

  const failures = checks.filter((entry) => !entry.passed)
  return { passed: failures.length === 0, checks, failures }
}

async function main() {
  process.env.TEST_DB_POOL_SIZE ??= '4'
  process.env.VESPER_E2E_DB_POOL_SIZE ??= '4'
  const config = readConfig()
  fs.mkdirSync(path.dirname(config.jsonOutputPath), { recursive: true })

  const stack = await bootServerStack()
  const fixturePath = path.join(stack.artifactDir, 'account-profile-fixture.json')
  const storagePath = path.join(stack.artifactDir, 'account-profile-storage.json')
  const primaryStorage = new FileCryptoStorage(storagePath)
  const primaryMeter = createFetchMeter(config.network)
  const primary = createDeviceHarness(stack.apiUrl, 'account-profile-primary', {
    storage: primaryStorage,
    fetchImpl: primaryMeter.fetchImpl
  })
  const username = `profile_${Date.now().toString(36)}`
  const password = 'vesper-account-profile-password'
  const scenarios = []
  let secondary = null
  let warm = null
  let expired = null

  try {
    const session = await primary.register(username, password)
    const userId = session.user.id

    const seedStartedAt = performance.now()
    runFixtureScript(stack, config, userId, fixturePath, 'seed')
    const fixtureSeedMs = performance.now() - seedStartedAt
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
    const firstPageCount = Math.min(100, fixture.total_conversation_count)

    scenarios.push(
      await measureScenario(
        'cold_compact_snapshot',
        primaryMeter,
        async () => await primary.client.syncNow(true),
        async (state) => {
          assertWorkspace(state, config, firstPageCount)
          return {
            workspaceSnapshotBytes: await workspaceSnapshotBytes(primaryStorage, userId),
            localStorageFileBytes: fs.statSync(storagePath).size,
            serverCount: state.servers.length,
            conversationCount: state.conversations.length,
            hasMoreConversations: state.conversationsHasMore
          }
        }
      )
    )

    if (fixture.total_conversation_count > firstPageCount) {
      scenarios.push(
        await measureScenario(
          'load_older_dm_page',
          primaryMeter,
          async () => await primary.client.loadMoreConversations(config.pageSize),
          async () => ({
            workspaceSnapshotBytes: await workspaceSnapshotBytes(primaryStorage, userId),
            localStorageFileBytes: fs.statSync(storagePath).size,
            conversationCount: primary.client.getState().conversations.length
          })
        )
      )
    }

    scenarios.push(
      await measureScenario(
        'lazy_server_open',
        primaryMeter,
        async () => await primary.client.fetchServerChannels(fixture.large_server_id),
        async (channels) => ({ channelCount: channels.length })
      )
    )

    scenarios.push(
      await measureScenario('no_change_delta', primaryMeter, async () => {
        const before = primary.client.getState().syncToken
        const state = await primary.client.syncNow(false)
        return { state, cursorAdvanced: state.syncToken !== before }
      }, async ({ state, cursorAdvanced }) => {
        assertWorkspace(state, config, primary.client.getState().conversations.length)
        return { cursorAdvanced }
      })
    )

    primary.client.stop()
    const warmMeter = createFetchMeter(config.network)
    const releaseWorkspaceSync = warmMeter.blockNextWorkspaceSync()
    warm = createDeviceHarness(stack.apiUrl, 'account-profile-warm', {
      deviceId: primary.deviceIdentity.id,
      sessionStore: primary.sessionStore,
      storage: primaryStorage,
      fetchImpl: warmMeter.fetchImpl
    })
    await warm.restoreSession()
    warmMeter.reset()
    const warmMemoryBefore = memorySnapshot()
    const warmStartedAt = performance.now()
    const warmStartPromise = warm.client.start(false)
    await waitFor('cached account workspace', async () => {
      return warm.client.getState().servers.length === config.servers
    })
    const cachedRenderMs = performance.now() - warmStartedAt
    releaseWorkspaceSync()
    await warmStartPromise
    const warmDurationMs = performance.now() - warmStartedAt
    const warmMemoryAfter = memorySnapshot()
    assertWorkspace(warm.client.getState(), config, warm.client.getState().conversations.length)
    scenarios.push({
      name: 'warm_cached_restart',
      durationMs: warmDurationMs,
      cachedRenderMs,
      network: warmMeter.snapshot(),
      memoryBefore: warmMemoryBefore,
      memoryAfter: warmMemoryAfter,
      memoryDelta: memoryDelta(warmMemoryBefore, warmMemoryAfter),
      workspaceSnapshotBytes: await workspaceSnapshotBytes(primaryStorage, userId),
      localStorageFileBytes: fs.statSync(storagePath).size
    })

    const deltaConversationCount = warm.client.getState().conversations.length
    runFixtureScript(stack, config, userId, fixturePath, 'append_changes')
    scenarios.push(
      await measureScenario(
        'bounded_delta_with_unrelated_traffic',
        warmMeter,
        async () => await warm.client.syncNow(false),
        async (state) => {
          assertWorkspace(state, config, deltaConversationCount)
          return {
            relevantChanges: config.deltaChanges,
            unrelatedChanges: config.unrelatedChanges,
            conversationCount: state.conversations.length
          }
        }
      )
    )

    const secondaryMeter = createFetchMeter(config.network)
    secondary = createDeviceHarness(stack.apiUrl, 'account-profile-secondary', {
      storage: new MemoryStorage(),
      fetchImpl: secondaryMeter.fetchImpl
    })
    await approveSecondary(warm, secondary, username, password)
    scenarios.push(
      await measureScenario(
        'second_device_compact_snapshot',
        secondaryMeter,
        async () => await secondary.client.syncNow(true),
        async (state) => {
          assertWorkspace(state, config, firstPageCount)
          return {
            serverCount: state.servers.length,
            conversationCount: state.conversations.length
          }
        }
      )
    )

    const snapshot = await primaryStorage.getWorkspaceSnapshot(userId)
    if (!snapshot?.token) {
      throw new Error('Cannot profile cursor expiry without a persisted workspace token')
    }
    await primaryStorage.setWorkspaceSnapshot(userId, {
      ...snapshot,
      token: ageCursor(snapshot.token)
    })
    warm.client.stop()

    const expiredMeter = createFetchMeter(config.network)
    expired = createDeviceHarness(stack.apiUrl, 'account-profile-expired', {
      deviceId: primary.deviceIdentity.id,
      sessionStore: primary.sessionStore,
      storage: primaryStorage,
      fetchImpl: expiredMeter.fetchImpl
    })
    await expired.restoreSession()
    scenarios.push(
      await measureScenario(
        'expired_cursor_compact_rebuild',
        expiredMeter,
        async () => await expired.client.start(false),
        async () => {
          const state = expired.client.getState()
          assertWorkspace(state, config, firstPageCount)
          if (expiredMeter.snapshot().fullSyncResponses !== 1) {
            throw new Error('Expired cursor did not force exactly one compact snapshot')
          }
          return {
            serverCount: state.servers.length,
            conversationCount: state.conversations.length,
            workspaceSnapshotBytes: await workspaceSnapshotBytes(primaryStorage, userId)
          }
        }
      )
    )

    const database = profileDatabase(stack, userId, config.pageSize)
    const budgetResults = evaluateBudgets(config, scenarios, database)
    const report = {
      generatedAt: new Date().toISOString(),
      host: {
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
        logicalCpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem()
      },
      config,
      fixture: {
        ...fixture,
        server_ids: undefined,
        recent_conversation_ids: undefined,
        seedDurationMs: fixtureSeedMs,
        physical: true,
        creationPath: 'direct database seed for inactive topology; real SDK/API sync operations'
      },
      scenarios,
      database,
      budgets: budgetResults,
      limitations: [
        'Runs on local loopback unless ACCOUNT_PROFILE_NETWORK_RTT_MS or ACCOUNT_PROFILE_BANDWIDTH_KBPS is set.',
        'Measures Node process memory and adapter-independent workspace JSON bytes; it does not launch Electron to sample renderer RSS.',
        'Inactive topology is inserted directly into PostgreSQL, while every measured sync operation uses the real SDK and HTTP API.',
        'Cryptographic send/decrypt behavior remains covered by the separate physical chaos suite.'
      ],
      correctness: {
        failures: 0,
        serverCount: config.servers,
        totalConversationCount: fixture.total_conversation_count,
        devicesConverged: 2,
        expiredCursorRebuilt: true
      }
    }

    fs.writeFileSync(config.jsonOutputPath, JSON.stringify(report, null, 2))
    console.log(`Account sync profile written to ${config.jsonOutputPath}`)
    console.log(`Fixture seed: ${fixtureSeedMs.toFixed(2)}ms`)
    for (const scenario of scenarios) {
      console.log(
        `${scenario.name}: ${scenario.durationMs.toFixed(2)}ms, ${scenario.network.callCount} calls, ${scenario.network.responseBytes} response bytes`
      )
    }
    console.log(
      `DM page SQL: ${database.dmPage.summary.executionTimeMs}ms, ${database.dmPage.summary.sharedHitBlocks} shared hit blocks`
    )
    console.log(
      `Scope delta SQL: ${database.scopeDelta.summary.executionTimeMs}ms, ${database.scopeDelta.summary.sharedHitBlocks} shared hit blocks`
    )
    console.log(
      `Budgets: ${budgetResults.passed ? 'pass' : `fail (${budgetResults.failures.length})`}`
    )

    if (config.enforceBudgets && !budgetResults.passed) {
      throw new Error(
        `Account sync profile exceeded budgets: ${budgetResults.failures
          .map((failure) => failure.name)
          .join(', ')}`
      )
    }
  } finally {
    primary.client.stop()
    warm?.client.stop()
    secondary?.client.stop()
    expired?.client.stop()
    if (!config.keepStack) {
      await teardownServerStack(stack)
    } else {
      console.log(`Keeping profile stack at ${stack.apiUrl}, database ${stack.dbName}`)
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
