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
import { profileDatabase } from './profile-account-database.mjs'

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
    busyGroupDms: readNonNegativeInt('ACCOUNT_PROFILE_BUSY_GROUP_DMS', smoke ? 10 : 2_500),
    messagesPerBusyGroup: readPositiveInt(
      'ACCOUNT_PROFILE_MESSAGES_PER_BUSY_GROUP',
      smoke ? 10 : 30
    ),
    deepHistoryMessages: readPositiveInt(
      'ACCOUNT_PROFILE_DEEP_HISTORY_MESSAGES',
      smoke ? 300 : 10_000
    ),
    busyServerChannels: readNonNegativeInt(
      'ACCOUNT_PROFILE_BUSY_SERVER_CHANNELS',
      smoke ? 5 : 250
    ),
    messagesPerBusyServerChannel: readPositiveInt(
      'ACCOUNT_PROFILE_MESSAGES_PER_BUSY_SERVER_CHANNEL',
      smoke ? 10 : 30
    ),
    historyPageSize: readPositiveInt('ACCOUNT_PROFILE_HISTORY_PAGE_SIZE', 50),
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
      ),
      historyPageMs: readPositiveInt('ACCOUNT_PROFILE_BUDGET_HISTORY_PAGE_MS', 100),
      historyPageResponseBytes: readPositiveInt(
        'ACCOUNT_PROFILE_BUDGET_HISTORY_PAGE_BYTES',
        131_072
      ),
      historyPageSqlMs: readPositiveInt('ACCOUNT_PROFILE_BUDGET_HISTORY_SQL_MS', 25),
      historyPageSharedBlocks: readPositiveInt(
        'ACCOUNT_PROFILE_BUDGET_HISTORY_SHARED_BLOCKS',
        5_000
      ),
      messageStorageBytes: readPositiveInt(
        'ACCOUNT_PROFILE_BUDGET_MESSAGE_STORAGE_BYTES',
        268_435_456
      )
    },
    enforceBudgets: process.env.ACCOUNT_PROFILE_ENFORCE_BUDGETS !== '0',
    jsonOutputPath:
      process.env.ACCOUNT_PROFILE_JSON_OUTPUT ??
      path.join(SDK_ROOT, 'artifacts', `account-sync-profile-${profileName}.json`),
    keepStack: process.env.ACCOUNT_PROFILE_KEEP_STACK === '1'
  }
}

function validateConfig(config) {
  if (config.busyGroupDms === 0 || config.busyGroupDms > config.groupDms) {
    throw new Error('ACCOUNT_PROFILE_BUSY_GROUP_DMS must be between 1 and ACCOUNT_PROFILE_GROUP_DMS')
  }
  if (config.busyServerChannels === 0 || config.busyServerChannels > config.servers) {
    throw new Error(
      'ACCOUNT_PROFILE_BUSY_SERVER_CHANNELS must be between 1 and ACCOUNT_PROFILE_SERVERS'
    )
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
      ACCOUNT_PROFILE_BUSY_GROUP_DMS: String(config.busyGroupDms),
      ACCOUNT_PROFILE_MESSAGES_PER_BUSY_GROUP: String(config.messagesPerBusyGroup),
      ACCOUNT_PROFILE_DEEP_HISTORY_MESSAGES: String(config.deepHistoryMessages),
      ACCOUNT_PROFILE_BUSY_SERVER_CHANNELS: String(config.busyServerChannels),
      ACCOUNT_PROFILE_MESSAGES_PER_BUSY_SERVER_CHANNEL: String(
        config.messagesPerBusyServerChannel
      ),
      ACCOUNT_PROFILE_DELTA_CHANGES: String(config.deltaChanges),
      ACCOUNT_PROFILE_UNRELATED_CHANGES: String(config.unrelatedChanges)
    }),
    stdio: 'inherit'
  })
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
  payload.synced_at = new Date(Date.now() - 8 * DAY_MS).toISOString()
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
  const historyScenarios = [
    byName.get('busy_group_latest_window'),
    byName.get('busy_group_older_window'),
    byName.get('busy_server_latest_window'),
    byName.get('second_device_latest_scope_window')
  ].filter(Boolean)

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
    'busy history page latency',
    Math.max(...historyScenarios.map((scenario) => scenario.durationMs)),
    config.budgets.historyPageMs,
    'ms'
  )
  check(
    'busy history page response',
    Math.max(...historyScenarios.map((scenario) => scenario.network.responseBytes)),
    config.budgets.historyPageResponseBytes,
    'bytes'
  )
  check(
    'busy history SQL latency',
    Math.max(
      database.dmHistoryPage.summary.executionTimeMs,
      database.channelHistoryPage.summary.executionTimeMs
    ),
    config.budgets.historyPageSqlMs,
    'ms'
  )
  check(
    'busy history shared buffers',
    Math.max(
      database.dmHistoryPage.summary.sharedHitBlocks,
      database.channelHistoryPage.summary.sharedHitBlocks
    ),
    config.budgets.historyPageSharedBlocks,
    'blocks'
  )
  check(
    'message and room-event storage',
    database.storage.combined_bytes,
    config.budgets.messageStorageBytes,
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
  validateConfig(config)
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
  let latestBusyGroupMessages = []

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
        'busy_group_latest_window',
        primaryMeter,
        async () =>
          await primary.fetchConversationMessages(fixture.busy_group_conversation_id, {
            limit: config.historyPageSize,
            lean: true
          }),
        async (messages) => {
          latestBusyGroupMessages = messages
          if (messages.length !== config.historyPageSize) {
            throw new Error(
              `Expected ${config.historyPageSize} latest busy-group messages, received ${messages.length}`
            )
          }
          return {
            messageCount: messages.length,
            totalHistoryMessages: fixture.deep_history_messages
          }
        }
      )
    )

    const oldestLatestMessage = latestBusyGroupMessages.at(-1)
    if (!oldestLatestMessage) {
      throw new Error('Busy-group latest window was empty')
    }

    const beforeCursor = `${oldestLatestMessage.inserted_at}|${oldestLatestMessage.id}`
    scenarios.push(
      await measureScenario(
        'busy_group_older_window',
        primaryMeter,
        async () =>
          await primary.fetchConversationMessages(fixture.busy_group_conversation_id, {
            limit: config.historyPageSize,
            before: beforeCursor,
            lean: true
          }),
        async (messages) => {
          if (messages.length !== config.historyPageSize) {
            throw new Error(
              `Expected ${config.historyPageSize} older busy-group messages, received ${messages.length}`
            )
          }
          const latestIds = new Set(latestBusyGroupMessages.map((message) => message.id))
          if (messages.some((message) => latestIds.has(message.id))) {
            throw new Error('Busy-group history pages overlap')
          }
          return { messageCount: messages.length, pagesOverlap: false }
        }
      )
    )

    scenarios.push(
      await measureScenario(
        'busy_server_latest_window',
        primaryMeter,
        async () =>
          await primary.fetchChannelMessages(fixture.busy_server_channel_id, {
            limit: Math.min(config.historyPageSize, config.messagesPerBusyServerChannel),
            lean: true
          }),
        async (messages) => ({ messageCount: messages.length })
      )
    )

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
          const addedConversationSummaries = state.conversations.length - deltaConversationCount
          if (addedConversationSummaries < 0 || addedConversationSummaries > config.deltaChanges) {
            throw new Error(
              `Delta materialized ${addedConversationSummaries} conversation summaries for ${config.deltaChanges} changed scopes`
            )
          }
          assertWorkspace(state, config, state.conversations.length)
          return {
            relevantChanges: config.deltaChanges,
            unrelatedChanges: config.unrelatedChanges,
            addedConversationSummaries,
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

    scenarios.push(
      await measureScenario(
        'second_device_latest_scope_window',
        secondaryMeter,
        async () =>
          await secondary.fetchScopesSync({
            scopes: [{ kind: 'dm', id: fixture.busy_group_conversation_id }],
            limit: config.historyPageSize
          }),
        async (response) => {
          const scope = response.scopes[0]
          if (!scope || scope.messages.length !== config.historyPageSize || scope.has_more !== true) {
            throw new Error('Second device did not receive one bounded latest busy-group window')
          }
          return {
            messageCount: scope.messages.length,
            hasMore: scope.has_more,
            latestRoomSeq: scope.latest_room_seq
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

    const database = profileDatabase(
      stack,
      userId,
      config.pageSize,
      config.historyPageSize,
      fixture
    )
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
        busy_server_channel_id: undefined,
        busy_group_conversation_id: undefined,
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
        'Inactive topology and historical ciphertext are inserted directly into PostgreSQL, while every measured sync and history operation uses the real SDK and HTTP API.',
        'Bulk seeded history measures bounded query, transfer, memory, and storage behavior; cryptographic send/decrypt throughput remains covered by the separate physical chaos suite.',
        'The deep-history fixture proves indexed progressive disclosure at 10,000 messages in one group, not the storage footprint of every possible multi-year deployment.'
      ],
      correctness: {
        failures: 0,
        serverCount: config.servers,
        totalConversationCount: fixture.total_conversation_count,
        totalSeededMessageCount: fixture.total_seeded_message_count,
        deepHistoryMessages: fixture.deep_history_messages,
        devicesConverged: 2,
        latestHistoryWindowBounded: true,
        olderHistoryWindowBounded: true,
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
      `Busy DM history SQL: ${database.dmHistoryPage.summary.executionTimeMs}ms, ${database.dmHistoryPage.summary.sharedHitBlocks} shared hit blocks`
    )
    console.log(
      `Busy channel history SQL: ${database.channelHistoryPage.summary.executionTimeMs}ms, ${database.channelHistoryPage.summary.sharedHitBlocks} shared hit blocks`
    )
    console.log(
      `Message storage: ${database.storage.message_count} messages, ${database.storage.combined_bytes} bytes with room events`
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
