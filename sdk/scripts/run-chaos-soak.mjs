#!/usr/bin/env node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { loadRepoEnv } from '../../scripts/load-repo-env.mjs'

import { bootServerStack, teardownServerStack } from '../dist/testing/index.js'

loadRepoEnv()

function readIntEnv(name, fallback) {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }

  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function readStringEnv(name, fallback = null) {
  const raw = process.env[name]
  return raw && raw.length > 0 ? raw : fallback
}

function percentile(samples, ratio) {
  if (samples.length === 0) {
    return null
  }

  const sorted = [...samples].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index]
}

function summarizeSamples(samples) {
  return {
    count: samples.length,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    max: samples.length > 0 ? Math.max(...samples) : null
  }
}

function formatMs(value) {
  return value == null ? 'n/a' : `${value.toFixed(2)}ms`
}

function createConfig() {
  const available = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length

  return {
    activeChannelCount: readIntEnv('CHAOS_ACTIVE_CHANNEL_COUNT', readIntEnv('CHAOS_CHANNEL_COUNT', 8)),
    auditSamples: readIntEnv('CHAOS_AUDIT_SAMPLES', 6),
    channelCount: readIntEnv('CHAOS_CHANNEL_COUNT', 8),
    deliverySampleEvery: readIntEnv('CHAOS_DELIVERY_SAMPLE_EVERY', 4),
    deliveryTimeoutMs: readIntEnv('CHAOS_DELIVERY_TIMEOUT_MS', 2_000),
    durationSeconds: readIntEnv('CHAOS_DURATION_SECONDS', 120),
    dbPoolSize: readIntEnv('CHAOS_DB_POOL_SIZE', 64),
    expectedWindow: readIntEnv('CHAOS_EXPECTED_WINDOW', 320),
    historySeedMessages: readIntEnv('CHAOS_HISTORY_SEED_MESSAGES', 120),
    profileIntervalMs: readIntEnv('CHAOS_PROFILE_INTERVAL_MS', 5_000),
    restoreBatchSize: readIntEnv('CHAOS_RESTORE_BATCH_SIZE', 240),
    restorePageSize: readIntEnv('CHAOS_RESTORE_PAGE_SIZE', 80),
    scopeCohortSize: readIntEnv('CHAOS_SCOPE_COHORT_SIZE', 0),
    scopesPerActor: readIntEnv('CHAOS_SCOPES_PER_ACTOR', 2),
    secondaryEvery: readIntEnv('CHAOS_SECONDARY_EVERY', 0),
    targetLatencyMs: readIntEnv('CHAOS_TARGET_LATENCY_MS', 30),
    totalUsers: readIntEnv('CHAOS_TOTAL_USERS', 8_000),
    wideRestoreScopes: readIntEnv('CHAOS_WIDE_RESTORE_SCOPES', 3),
    workerCount: readIntEnv('CHAOS_WORKER_COUNT', Math.min(8, Math.max(2, available))),
    useSharedFixture:
      (readStringEnv('CHAOS_USE_SHARED_FIXTURE', '1') ?? '1').toLowerCase() !== '0',
    artifactRoot:
      readStringEnv('CHAOS_ARTIFACT_DIR') ??
      path.join(process.cwd(), 'packages', 'sdk', 'artifacts', `soak-${Date.now()}`)
  }
}

function splitUsers(totalUsers, workerCount) {
  const base = Math.floor(totalUsers / workerCount)
  const remainder = totalUsers % workerCount

  return Array.from({ length: workerCount }, (_, index) => {
    return base + (index < remainder ? 1 : 0)
  }).filter((count) => count > 0)
}

function splitCounts(totalCount, workerCount, minimumPerWorker = 1) {
  const slices = splitUsers(totalCount, workerCount)

  if (slices.length === workerCount) {
    return slices
  }

  return Array.from({ length: workerCount }, (_, index) => slices[index] ?? minimumPerWorker)
}

function prefixStream(stream, prefix) {
  let buffer = ''

  stream.on('data', (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (line.length > 0) {
        console.log(`${prefix} ${line}`)
      }
    }
  })

  stream.on('end', () => {
    if (buffer.length > 0) {
      console.log(`${prefix} ${buffer}`)
    }
  })
}

function readWorkerReport(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function aggregateWorkerReports(workerReports) {
  const mergedSamples = {
    auditSync: [],
    deliveryE2E: [],
    loginRestore: [],
    reconnectRestore: [],
    sendAck: [],
    syncRestore: [],
    wideRestore: []
  }

  let actualOps = 0
  let actorCount = 0
  let decryptFailures = 0
  let failures = 0
  let logicalOps = 0
  let restoreMisses = 0
  const decryptFailureSamples = []

  for (const report of workerReports) {
    actorCount += report.actorCount
    actualOps += report.metrics.actualOps
    decryptFailures += report.metrics.decryptFailures
    failures += report.metrics.failures
    logicalOps += report.metrics.logicalOps
    restoreMisses += report.metrics.restoreMisses
    decryptFailureSamples.push(...report.metrics.decryptFailureSamples)

    for (const [key, values] of Object.entries(report.metrics.samples)) {
      mergedSamples[key].push(...values)
    }
  }

  const summaries = Object.fromEntries(
    Object.entries(mergedSamples).map(([key, values]) => [key, summarizeSamples(values)])
  )

  return {
    actorCount,
    decryptFailureSamples: decryptFailureSamples.slice(0, 10),
    metrics: {
      actualOps,
      decryptFailures,
      failures,
      logicalOps,
      restoreMisses,
      samples: mergedSamples
    },
    summaries
  }
}

function printAggregateSummary(config, soakDurationMs, aggregate) {
  console.log('')
  console.log('Chaos soak summary')
  console.log(`- total users: ${config.totalUsers.toLocaleString()}`)
  console.log(`- total channels: ${config.channelCount.toLocaleString()}`)
  console.log(`- active channels: ${config.activeChannelCount.toLocaleString()}`)
  if (config.scopeCohortSize > 0) {
    console.log(`- max actors per active channel: ${config.scopeCohortSize.toLocaleString()}`)
  }
  console.log(`- worker count: ${config.workerCount.toLocaleString()}`)
  console.log(`- total actors: ${aggregate.actorCount.toLocaleString()}`)
  console.log(`- soak duration: ${(soakDurationMs / 1000).toFixed(1)}s`)
  console.log(`- actual operations: ${aggregate.metrics.actualOps.toLocaleString()}`)
  console.log(`- logical operations: ${Math.round(aggregate.metrics.logicalOps).toLocaleString()}`)
  console.log(`- failures: ${aggregate.metrics.failures}`)
  console.log(`- decrypt failures: ${aggregate.metrics.decryptFailures}`)
  console.log(`- restore misses: ${aggregate.metrics.restoreMisses}`)
  if (aggregate.decryptFailureSamples.length > 0) {
    console.log(`- decrypt failure samples: ${aggregate.decryptFailureSamples.join(', ')}`)
  }
  console.log(`- send ack p95: ${formatMs(aggregate.summaries.sendAck.p95)}`)
  console.log(`- delivery e2e p95: ${formatMs(aggregate.summaries.deliveryE2E.p95)}`)
  console.log(`- reconnect restore p95: ${formatMs(aggregate.summaries.reconnectRestore.p95)}`)
  console.log(`- login restore p95: ${formatMs(aggregate.summaries.loginRestore.p95)}`)
  console.log(`- sync restore p95: ${formatMs(aggregate.summaries.syncRestore.p95)}`)
  console.log(`- audit sync p95: ${formatMs(aggregate.summaries.auditSync.p95)}`)
  console.log(`- wide restore p95: ${formatMs(aggregate.summaries.wideRestore.p95)}`)
}

async function sampleServerProcess(pid) {
  const result = await spawnSyncSafe('ps', ['-o', 'rss=,%cpu=', '-p', String(pid)])
  if (result == null) {
    return null
  }

  const [rssKbRaw, cpuRaw] = result.trim().split(/\s+/)
  return {
    cpuPercent: Number.parseFloat(cpuRaw),
    rssMb: Number.parseFloat(rssKbRaw) / 1024
  }
}

async function sampleDatabase(dbName) {
  const host = process.env.TEST_DB_HOST ?? process.env.VESPER_SDK_TEST_DB_HOST ?? '127.0.0.1'
  const port = process.env.TEST_DB_PORT ?? process.env.VESPER_SDK_TEST_DB_PORT ?? '55432'
  const user = process.env.TEST_DB_USER ?? process.env.VESPER_SDK_TEST_DB_USER ?? 'vesper_sdk'
  const password = process.env.TEST_DB_PASS ?? process.env.VESPER_SDK_TEST_DB_PASS ?? 'vesper_sdk'
  const containerName =
    process.env.VESPER_SDK_TEST_DB_CONTAINER ?? 'vesper-sdk-test-postgres'

  const sql = `
SELECT
  numbackends,
  xact_commit,
  blks_read,
  blks_hit,
  tup_inserted,
  tup_updated,
  tup_deleted,
  temp_files,
  temp_bytes,
  deadlocks
FROM pg_stat_database
WHERE datname = current_database();
SELECT
  count(*) FILTER (WHERE state = 'active'),
  count(*)
FROM pg_stat_activity
WHERE datname = current_database();
`

  let result = await spawnSyncSafe(
    'psql',
    ['-h', host, '-p', port, '-U', user, '-d', dbName, '-AtF', ',', '-c', sql],
    {
      env: {
        ...process.env,
        PGPASSWORD: password
      }
    }
  )

  if (result == null) {
    result = await spawnSyncSafe(
      'docker',
      [
        'exec',
        '-e',
        `PGPASSWORD=${password}`,
        containerName,
        'psql',
        '-U',
        user,
        '-d',
        dbName,
        '-AtF',
        ',',
        '-c',
        sql
      ],
      {
        env: process.env
      }
    )
  }

  if (result == null) {
    return null
  }

  const lines = result
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length < 2) {
    return null
  }

  const [databaseStats, activityStats] = lines
  const [
    numbackends,
    xactCommit,
    blksRead,
    blksHit,
    tupInserted,
    tupUpdated,
    tupDeleted,
    tempFiles,
    tempBytes,
    deadlocks
  ] = databaseStats.split(',').map((value) => Number.parseInt(value, 10))
  const [activeConnections, totalConnections] = activityStats
    .split(',')
    .map((value) => Number.parseInt(value, 10))

  return {
    activeConnections,
    blksHit,
    blksRead,
    deadlocks,
    numbackends,
    tempBytes,
    tempFiles,
    totalConnections,
    tupDeleted,
    tupInserted,
    tupUpdated,
    xactCommit
  }
}

function spawnSyncSafe(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.on('error', () => {
      resolve(null)
    })
    child.on('close', (code) => {
      resolve(code === 0 ? stdout : null)
    })
  })
}

async function collectProfileSnapshot(stack, eventLoopHistogram, startedAt) {
  const [serverProcess, database] = await Promise.all([
    sampleServerProcess(stack.process.pid),
    sampleDatabase(stack.dbName)
  ])

  return {
    atMs: performance.now() - startedAt,
    coordinatorRssMb: process.memoryUsage().rss / (1024 * 1024),
    database,
    eventLoopP95Ms: eventLoopHistogram.percentile(95) / 1_000_000,
    serverProcess
  }
}

async function spawnStrict(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString()
      stdout += text
      process.stdout.write(text)
    })
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      process.stderr.write(text)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}\n${stderr}`))
      }
    })
  })
}

async function createSharedFixture(stack, config) {
  const fixturePath = path.join(config.artifactRoot, 'shared-fixture.json')
  const serverDir = path.join(process.cwd(), 'server')
  const args = [
    'vesper.scale_fixture',
    '--output-path',
    fixturePath,
    '--label',
    `soak_${stack.runId}`,
    '--user-count',
    String(config.totalUsers),
    '--channel-count',
    String(config.channelCount),
    '--active-channel-count',
    String(config.activeChannelCount),
    '--secondary-every',
    String(config.secondaryEvery)
  ]

  console.log(
    `Seeding shared fixture with ${config.totalUsers.toLocaleString()} users, ${config.channelCount.toLocaleString()} channels, ${config.activeChannelCount.toLocaleString()} active channels`
  )

  await spawnStrict('mix', args, {
    cwd: serverDir,
    env: {
      ...process.env,
      MIX_ENV: 'test',
      MIX_TEST_PARTITION: `_sdk_${stack.runId}`,
      PORT: String(stack.apiPort),
      TEST_DB_HOST:
        process.env.TEST_DB_HOST ?? process.env.VESPER_SDK_TEST_DB_HOST ?? '127.0.0.1',
      TEST_DB_PASS:
        process.env.TEST_DB_PASS ?? process.env.VESPER_SDK_TEST_DB_PASS ?? 'vesper_sdk',
      TEST_DB_PORT:
        process.env.TEST_DB_PORT ?? process.env.VESPER_SDK_TEST_DB_PORT ?? '55432',
      TEST_DB_USER:
        process.env.TEST_DB_USER ?? process.env.VESPER_SDK_TEST_DB_USER ?? 'vesper_sdk',
      VESPER_E2E: '1',
      VESPER_E2E_DB_POOL_SIZE: String(Math.min(config.dbPoolSize, 4))
    }
  })

  return { fixturePath, fixture: JSON.parse(fs.readFileSync(fixturePath, 'utf8')) }
}

async function main() {
  const config = createConfig()
  fs.mkdirSync(config.artifactRoot, { recursive: true })
  process.env.VESPER_E2E_DB_POOL_SIZE = String(config.dbPoolSize)

  const stack = await bootServerStack()
  const startedAt = performance.now()
  const userSlices = splitUsers(config.totalUsers, config.workerCount)
  const activeChannelSlices = splitCounts(config.activeChannelCount, userSlices.length, 1)
  const eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 })
  const profile = []
  let profileTimer = null

  try {
    eventLoopHistogram.enable()
    const sharedFixture = config.useSharedFixture
      ? await createSharedFixture(stack, config)
      : null

    profileTimer = setInterval(async () => {
      try {
        const snapshot = await collectProfileSnapshot(stack, eventLoopHistogram, startedAt)
        profile.push(snapshot)
      } catch {
        // Keep the soak going even if a snapshot misses.
      }
    }, config.profileIntervalMs)

    const workerPromises = userSlices.map((userCount, index) => {
      const workerLabel = `worker-${index + 1}`
      const reportPath = path.join(config.artifactRoot, `${workerLabel}.json`)
      const child = spawn(
        process.execPath,
        [path.join(process.cwd(), 'packages', 'sdk', 'scripts', 'run-chaos-load.mjs')],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            CHAOS_ACTUAL_USERS: String(userCount),
            CHAOS_ACTIVE_CHANNEL_COUNT: String(activeChannelSlices[index] ?? 1),
            CHAOS_ACTIVE_CHANNEL_OFFSET: String(
              activeChannelSlices.slice(0, index).reduce((sum, count) => sum + count, 0)
            ),
            CHAOS_API_URL: stack.apiUrl,
            CHAOS_AUDIT_SAMPLES: String(config.auditSamples),
            CHAOS_CHANNEL_COUNT: String(config.channelCount),
            CHAOS_DELIVERY_SAMPLE_EVERY: String(config.deliverySampleEvery),
            CHAOS_DELIVERY_TIMEOUT_MS: String(config.deliveryTimeoutMs),
            CHAOS_DURATION_SECONDS: String(config.durationSeconds),
            CHAOS_EXPECTED_WINDOW: String(config.expectedWindow),
            CHAOS_HISTORY_SEED_MESSAGES: String(config.historySeedMessages),
            CHAOS_JSON_OUTPUT_PATH: reportPath,
            CHAOS_LABEL: workerLabel,
            CHAOS_RESTORE_BATCH_SIZE: String(config.restoreBatchSize),
            CHAOS_RESTORE_PAGE_SIZE: String(config.restorePageSize),
            CHAOS_SCOPE_COHORT_SIZE: String(config.scopeCohortSize),
            CHAOS_SCOPES_PER_ACTOR: String(config.scopesPerActor),
            CHAOS_SECONDARY_EVERY: String(config.secondaryEvery),
            CHAOS_SHARED_FIXTURE_PATH: sharedFixture?.fixturePath ?? '',
            CHAOS_SIMULATED_USERS: String(userCount),
            CHAOS_TARGET_LATENCY_MS: String(config.targetLatencyMs),
            CHAOS_USER_OFFSET: String(userSlices.slice(0, index).reduce((sum, count) => sum + count, 0)),
            CHAOS_WIDE_RESTORE_SCOPES: String(config.wideRestoreScopes),
            TEST_DB_HOST:
              process.env.TEST_DB_HOST ?? process.env.VESPER_SDK_TEST_DB_HOST ?? '127.0.0.1',
            TEST_DB_PASS:
              process.env.TEST_DB_PASS ?? process.env.VESPER_SDK_TEST_DB_PASS ?? 'vesper_sdk',
            TEST_DB_PORT:
              process.env.TEST_DB_PORT ?? process.env.VESPER_SDK_TEST_DB_PORT ?? '55432',
            TEST_DB_USER:
              process.env.TEST_DB_USER ?? process.env.VESPER_SDK_TEST_DB_USER ?? 'vesper_sdk'
          },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )

      prefixStream(child.stdout, `[${workerLabel}]`)
      prefixStream(child.stderr, `[${workerLabel}]`)

      return new Promise((resolve, reject) => {
        child.on('close', (code) => {
          if (code === 0) {
            resolve(reportPath)
          } else {
            reject(new Error(`${workerLabel} exited with code ${code}`))
          }
        })
      })
    })

    const reportPaths = await Promise.all(workerPromises)
    const workerReports = reportPaths.map(readWorkerReport)
    const aggregate = aggregateWorkerReports(workerReports)
    const soakDurationMs = performance.now() - startedAt

    printAggregateSummary(config, soakDurationMs, aggregate)

    const finalProfile = {
      aggregate,
      config,
      fixture: sharedFixture?.fixture ?? null,
      profile,
      soakDurationMs,
      stack: {
        apiUrl: stack.apiUrl,
        dbName: stack.dbName,
        runId: stack.runId
      },
      workerReports
    }

    fs.writeFileSync(
      path.join(config.artifactRoot, 'soak-report.json'),
      JSON.stringify(finalProfile, null, 2)
    )

    const missedTarget = Object.values(aggregate.summaries).some((summary) => {
      return summary.p95 != null && summary.p95 > config.targetLatencyMs
    })

    if (
      aggregate.metrics.failures > 0 ||
      aggregate.metrics.decryptFailures > 0 ||
      aggregate.metrics.restoreMisses > 0 ||
      missedTarget
    ) {
      process.exitCode = 1
    }
  } finally {
    if (profileTimer) {
      clearInterval(profileTimer)
    }

    eventLoopHistogram.disable()
    await teardownServerStack(stack)
  }
}

await main()
