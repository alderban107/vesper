#!/usr/bin/env node

import process from 'node:process'
import { performance } from 'node:perf_hooks'
import fs from 'node:fs'
import path from 'node:path'

import {
  bootServerStack,
  createChatHarness,
  createDeviceHarness,
  teardownServerStack
} from '../dist/testing/index.js'
import { getMyKeyPackageCount } from '../dist/api/crypto.js'

let shuttingDown = false

function readIntEnv(name, fallback) {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }

  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function readNonNegativeIntEnv(name, fallback) {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }

  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function readStringEnv(name, fallback = null) {
  const raw = process.env[name]
  return raw && raw.length > 0 ? raw : fallback
}

function readBooleanEnv(name, fallback) {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }

  return !['0', 'false', 'no'].includes(raw.toLowerCase())
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

function cloneSampleSets(samples) {
  return Object.fromEntries(
    Object.entries(samples).map(([key, values]) => [key, [...values]])
  )
}

function formatMs(value) {
  return value == null ? 'n/a' : `${value.toFixed(2)}ms`
}

function scopeTopic(scope) {
  return scope.kind === 'channel' ? `chat:channel:${scope.id}` : `dm:${scope.id}`
}

function pickRandom(list) {
  if (list.length === 0) {
    return null
  }

  const index = Math.floor(Math.random() * list.length)
  return list[index] ?? null
}

function pushRing(map, key, value, limit) {
  const existing = map.get(key) ?? []
  existing.push(value)
  if (existing.length > limit) {
    existing.splice(0, existing.length - limit)
  }
  map.set(key, existing)
}

function isExpectedShutdownError(error) {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message || ''
  const causeCode =
    typeof error.cause === 'object' && error.cause && 'code' in error.cause
      ? error.cause.code
      : null

  return shuttingDown && message.includes('fetch failed') && causeCode === 'ECONNREFUSED'
}

process.on('uncaughtException', (error) => {
  if (isExpectedShutdownError(error)) {
    return
  }

  console.error(error)
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  if (isExpectedShutdownError(reason)) {
    return
  }

  console.error(reason)
  process.exit(1)
})

async function withTimeout(promise, timeoutMs, description) {
  let timeoutId = null

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Timed out during ${description}`))
        }, timeoutMs)
      })
    ])
  } finally {
    if (timeoutId != null) {
      clearTimeout(timeoutId)
    }
  }
}

async function waitFor(description, predicate, timeoutMs = 10_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  let lastError = null

  while (Date.now() < deadline) {
    try {
      const result = await predicate()
      if (result) {
        return result
      }
    } catch (error) {
      lastError = error
    }

    await waitInterval(intervalMs)
  }

  throw lastError ?? new Error(`Timed out waiting for ${description}`)
}

async function waitInterval(ms) {
  return await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function approveAndUnlockSecondary(primary, secondary, username, password) {
  const session = await secondary.login(username, password)
  if (session.currentDevice?.trust_state !== 'pending') {
    throw new Error(`Expected pending trust state for ${secondary.deviceIdentity.id}`)
  }

  const pendingDevice = await waitFor('secondary device approval visibility', async () => {
    const state = await primary.fetchDevices()
    return (
      state.devices.find((device) => device.client_id === secondary.deviceIdentity.id) ?? null
    )
  })

  await primary.approveDevice(pendingDevice.id)

  await waitFor('secondary device trusted state', async () => {
    const state = await secondary.fetchDevices()
    return state.currentDevice?.trust_state === 'trusted' ? state : null
  })

  await secondary.unlockTrustedDevice(password)
}

async function waitForKeyPackages(device, minimumCount = 1, timeoutMs = 10_000) {
  await waitFor(
    `key packages for ${device.deviceIdentity.id}`,
    async () => {
      const count = await device.run(() =>
        getMyKeyPackageCount(device.deviceIdentity.id, device.httpClient)
      )
      return count >= minimumCount ? count : null
    },
    timeoutMs,
    100
  )
}

function readConfig() {
  return {
    activeChannelCount: readIntEnv('CHAOS_ACTIVE_CHANNEL_COUNT', readIntEnv('CHAOS_CHANNEL_COUNT', 6)),
    actualUsers: readIntEnv('CHAOS_ACTUAL_USERS', 12),
    auditSamples: readIntEnv('CHAOS_AUDIT_SAMPLES', 6),
    channelCount: readIntEnv('CHAOS_CHANNEL_COUNT', 6),
    bootstrapTimeoutMs: readIntEnv('CHAOS_BOOTSTRAP_TIMEOUT_MS', 20_000),
    deliverySampleEvery: readIntEnv('CHAOS_DELIVERY_SAMPLE_EVERY', 4),
    deliveryTimeoutMs: readIntEnv('CHAOS_DELIVERY_TIMEOUT_MS', 2_000),
    durationSeconds: readIntEnv('CHAOS_DURATION_SECONDS', 60),
    expectedWindow: readIntEnv('CHAOS_EXPECTED_WINDOW', 240),
    historySeedMessages: readIntEnv('CHAOS_HISTORY_SEED_MESSAGES', 180),
    loginRestoreEnabled: readBooleanEnv('CHAOS_ENABLE_LOGIN_RESTORE', true),
    multiCohortSize: readNonNegativeIntEnv('CHAOS_MULTI_COHORT_SIZE', 4),
    restorePageSize: readIntEnv('CHAOS_RESTORE_PAGE_SIZE', 80),
    restoreBatchSize: readIntEnv('CHAOS_RESTORE_BATCH_SIZE', 240),
    scopesPerActor: readIntEnv('CHAOS_SCOPES_PER_ACTOR', 2),
    scopeCohortSize: readNonNegativeIntEnv('CHAOS_SCOPE_COHORT_SIZE', 0),
    secondaryEvery: readIntEnv('CHAOS_SECONDARY_EVERY', 2),
    simulatedUsers: readIntEnv('CHAOS_SIMULATED_USERS', 500_000),
    targetLatencyMs: readIntEnv('CHAOS_TARGET_LATENCY_MS', 30),
    wideRestoreScopes: readIntEnv('CHAOS_WIDE_RESTORE_SCOPES', 3),
    apiUrl: readStringEnv('CHAOS_API_URL'),
    jsonOutputPath: readStringEnv('CHAOS_JSON_OUTPUT_PATH'),
    label: readStringEnv('CHAOS_LABEL', 'default'),
    activeChannelOffset: readIntEnv('CHAOS_ACTIVE_CHANNEL_OFFSET', 0),
    sharedFixturePath: readStringEnv('CHAOS_SHARED_FIXTURE_PATH'),
    userOffset: readIntEnv('CHAOS_USER_OFFSET', 0)
  }
}

function buildScopeAssignments(channelIds, actorCount, scopesPerActor, scopeCohortSize) {
  const normalizedScopeCount = Math.min(scopesPerActor, channelIds.length)
  const perScopeLimit =
    scopeCohortSize > 0 ? scopeCohortSize : Number.POSITIVE_INFINITY
  const assignments = Array.from({ length: actorCount }, () => [])

  if (normalizedScopeCount === 0 || actorCount === 0) {
    return assignments
  }

  const assignedCounts = new Array(channelIds.length).fill(0)

  for (let actorIndex = 0; actorIndex < actorCount; actorIndex += 1) {
    let cursor = actorIndex % channelIds.length
    let attempts = 0

    while (
      assignments[actorIndex].length < normalizedScopeCount &&
      attempts < channelIds.length * 2
    ) {
      const channelIndex = cursor % channelIds.length
      const scopeId = channelIds[channelIndex]
      const alreadyAssigned = assignments[actorIndex].some((scope) => scope.id === scopeId)

      if (!alreadyAssigned && assignedCounts[channelIndex] < perScopeLimit) {
        assignments[actorIndex].push({
          id: scopeId,
          kind: 'channel'
        })
        assignedCounts[channelIndex] += 1
      }

      cursor += 1
      attempts += 1
    }
  }

  return assignments
}

function bootstrapTimeoutMs(config, actorCountForScope) {
  return Math.max(config.bootstrapTimeoutMs, 600 * Math.max(1, actorCountForScope))
}

function seedTimeoutMs(seedMessageCount) {
  return Math.max(12_000, 75 * Math.max(1, seedMessageCount))
}

function createMetrics() {
  return {
    actualOps: 0,
    applicationFanoutPublishes: 0,
    decryptFailureKeys: new Set(),
    decryptFailureSamples: [],
    decryptFailures: 0,
    failureSamples: [],
    failures: 0,
    logicalOps: 0,
    messagesSent: 0,
    repairEventKeys: new Set(),
    repairEvents: 0,
    restoreMisses: 0,
    samples: {
      auditSync: [],
      deliveryE2E: [],
      loginRestore: [],
      reconnectRestore: [],
      sendAck: [],
      syncRestore: [],
      wideRestore: []
    }
  }
}

function recordMetric(metrics, key, durationMs, logicalWeight) {
  metrics.actualOps += 1
  metrics.logicalOps += logicalWeight
  metrics.samples[key].push(durationMs)
}

function recordFailure(metrics, label, error) {
  metrics.failures += 1
  if (metrics.failureSamples.length < 5) {
    const message = error instanceof Error ? error.message : String(error)
    metrics.failureSamples.push(`${label}: ${message}`)
  }
}

function buildScaleMetrics(state, metrics) {
  return {
    activeScopes: state.scale?.activeScopes ?? 0,
    applicationFanoutPublishes: metrics.applicationFanoutPublishes,
    cohortCount: state.scale?.cohortCount ?? 0,
    envelopeCount: state.scale?.envelopeCount ?? 0,
    messagesSent: metrics.messagesSent,
    physicalParticipants: state.scale?.physicalParticipants ?? state.actors.length,
    scopeQueryCount: state.actors.reduce((total, actor) => total + actor.scopeQueryCount, 0)
  }
}

function summarizeMetrics(metrics, config, actorCount, durationMs, scaleMetrics) {
  const summaries = {
    auditSync: summarizeSamples(metrics.samples.auditSync),
    deliveryE2E: summarizeSamples(metrics.samples.deliveryE2E),
    loginRestore: summarizeSamples(metrics.samples.loginRestore),
    reconnectRestore: summarizeSamples(metrics.samples.reconnectRestore),
    sendAck: summarizeSamples(metrics.samples.sendAck),
    syncRestore: summarizeSamples(metrics.samples.syncRestore),
    wideRestore: summarizeSamples(metrics.samples.wideRestore)
  }

  console.log('')
  console.log('Chaos load summary')
  console.log(`- simulated users: ${config.simulatedUsers.toLocaleString()}`)
  console.log(`- actual users: ${config.actualUsers.toLocaleString()}`)
  console.log(`- actual actors: ${actorCount.toLocaleString()}`)
  console.log(`- duration: ${(durationMs / 1000).toFixed(1)}s`)
  console.log(`- actual operations: ${metrics.actualOps.toLocaleString()}`)
  console.log(`- logical operations: ${Math.round(metrics.logicalOps).toLocaleString()}`)
  console.log(
    `- logical ops/min: ${Math.round((metrics.logicalOps * 60_000) / Math.max(durationMs, 1)).toLocaleString()}`
  )
  console.log(`- failures: ${metrics.failures}`)
  if (metrics.failureSamples.length > 0) {
    process.stdout.write(`- failure samples: ${metrics.failureSamples.join(' | ')}\n`)
  }
  console.log(`- decrypt failures: ${metrics.decryptFailures}`)
  console.log(`- restore misses: ${metrics.restoreMisses}`)
  process.stdout.write(`- repair/resync events: ${metrics.repairEvents}\n`)
  process.stdout.write(`- physical participants: ${scaleMetrics.physicalParticipants}\n`)
  process.stdout.write(`- active multi-cohort scopes: ${scaleMetrics.activeScopes}\n`)
  process.stdout.write(`- physical cohorts: ${scaleMetrics.cohortCount}\n`)
  process.stdout.write(`- room-key envelopes: ${scaleMetrics.envelopeCount}\n`)
  process.stdout.write(`- scope query requests: ${scaleMetrics.scopeQueryCount}\n`)
  process.stdout.write(`- application fanout publishes: ${scaleMetrics.applicationFanoutPublishes}\n`)
  process.stdout.write(`- messages sent: ${scaleMetrics.messagesSent}\n`)
  if (metrics.decryptFailureSamples.length > 0) {
    console.log(`- decrypt failure samples: ${metrics.decryptFailureSamples.join(', ')}`)
  }
  console.log('')
  console.log(`Latency target: p95 < ${config.targetLatencyMs}ms`)
  console.log(
    `- send ack: count=${summaries.sendAck.count} p50=${formatMs(summaries.sendAck.p50)} p95=${formatMs(summaries.sendAck.p95)} p99=${formatMs(summaries.sendAck.p99)}`
  )
  console.log(
    `- delivery e2e: count=${summaries.deliveryE2E.count} p50=${formatMs(summaries.deliveryE2E.p50)} p95=${formatMs(summaries.deliveryE2E.p95)} p99=${formatMs(summaries.deliveryE2E.p99)}`
  )
  console.log(
    `- reconnect restore: count=${summaries.reconnectRestore.count} p50=${formatMs(summaries.reconnectRestore.p50)} p95=${formatMs(summaries.reconnectRestore.p95)} p99=${formatMs(summaries.reconnectRestore.p99)}`
  )
  console.log(
    `- login restore: count=${summaries.loginRestore.count} p50=${formatMs(summaries.loginRestore.p50)} p95=${formatMs(summaries.loginRestore.p95)} p99=${formatMs(summaries.loginRestore.p99)}`
  )
  console.log(
    `- sync restore: count=${summaries.syncRestore.count} p50=${formatMs(summaries.syncRestore.p50)} p95=${formatMs(summaries.syncRestore.p95)} p99=${formatMs(summaries.syncRestore.p99)}`
  )
  console.log(
    `- audit sync: count=${summaries.auditSync.count} p50=${formatMs(summaries.auditSync.p50)} p95=${formatMs(summaries.auditSync.p95)} p99=${formatMs(summaries.auditSync.p99)}`
  )
  console.log(
    `- wide restore: count=${summaries.wideRestore.count} p50=${formatMs(summaries.wideRestore.p50)} p95=${formatMs(summaries.wideRestore.p95)} p99=${formatMs(summaries.wideRestore.p99)}`
  )
  console.log('')
  console.log('Hot-path notes')
  console.log(`- total channels provisioned: ${config.channelCount}`)
  console.log(`- active encrypted channels: ${config.activeChannelCount}`)
  console.log('- unread counts now compare against stored last_read_seq')
  console.log(`- seeded history per scope: ${config.historySeedMessages}`)
  console.log(`- wide restore scopes: ${config.wideRestoreScopes}`)
  console.log('- the harness uses compressed cohorts, so logical load is projected from fewer real actors')
  console.log('- the run still exercises real SDK auth, socket, MLS, restore, and decrypt paths')

  return summaries
}

function buildReport(config, actorCount, durationMs, metrics, summaries, scaleMetrics) {
  return {
    actorCount,
    config,
    durationMs,
    metrics: {
      actualOps: metrics.actualOps,
      applicationFanoutPublishes: metrics.applicationFanoutPublishes,
      decryptFailureSamples: [...metrics.decryptFailureSamples],
      decryptFailures: metrics.decryptFailures,
      failureSamples: [...metrics.failureSamples],
      failures: metrics.failures,
      logicalOps: metrics.logicalOps,
      messagesSent: metrics.messagesSent,
      repairEvents: metrics.repairEvents,
      restoreMisses: metrics.restoreMisses,
      samples: cloneSampleSets(metrics.samples)
    },
    scale: scaleMetrics,
    summaries
  }
}

function writeJsonReport(outputPath, report) {
  if (!outputPath) {
    return
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2))
}

function createActor(device, username, password, scopes, trustedSecondary) {
  return {
    chat: createChatHarness(device),
    connected: true,
    device,
    password,
    scopeQueryCount: 0,
    scopes,
    trustedSecondary,
    username
  }
}

async function establishScopeViaNetwork(primaryActor, peers, scope, config) {
  const primaryReady = await primaryActor.chat.ensureScopeReady(scope, true)
  if (!primaryReady) {
    throw new Error(`Primary actor could not create ${scope.kind}:${scope.id}`)
  }

  const establishedActors = [primaryActor]

  for (const peer of peers) {
    const previousEpoch = primaryActor.chat.getGroupEpoch(scope.id)
    await peer.device.replenishKeyPackages()
    await waitForKeyPackages(peer.device)

    const joined = await waitFor(
      `network bootstrap for ${peer.username}:${scope.id}`,
      async () => {
        const ready = await peer.chat.ensureScopeReady(scope, false)
        return ready ? true : null
      },
      bootstrapTimeoutMs(config, peers.length),
      100
    )

    if (!joined) {
      throw new Error(`Peer could not join ${scope.kind}:${scope.id}`)
    }

    const expectedEpoch = await waitFor(
      `sponsor epoch advance for ${peer.username}:${scope.id}`,
      async () => {
        await primaryActor.chat.ensureScopeReady(scope, false)
        const epoch = primaryActor.chat.getGroupEpoch(scope.id)
        return epoch != null && epoch !== previousEpoch ? epoch : null
      },
      bootstrapTimeoutMs(config, peers.length),
      100
    )

    for (const actor of [...establishedActors, peer]) {
      await waitFor(
        `epoch ${expectedEpoch} convergence for ${actor.username}:${scope.id}`,
        async () => {
          await actor.chat.ensureScopeReady(scope, false)
          return actor.chat.getGroupEpoch(scope.id) === expectedEpoch ? true : null
        },
        bootstrapTimeoutMs(config, peers.length),
        100
      )
    }

    establishedActors.push(peer)
  }
}

async function seedScopeHistory(scope, actors, expectedByScope, config, state = null) {
  if (actors.length === 0 || config.historySeedMessages <= 0) {
    return
  }

  for (let index = 0; index < config.historySeedMessages; index += 1) {
    const actor = actors[index % actors.length]
    const text = `seed:${scope.id}:${index}`
    await actor.chat.sendText(scope, text)
    pushRing(expectedByScope, scope.id, text, config.expectedWindow)
    if (state) {
      touchScope(state, scope.id)
    }
  }
}

function touchScope(state, scopeId) {
  state.lastTouchedAtByScope.set(scopeId, Date.now())
}

async function migrateScopeToMultiCohort(scope, participants, config) {
  if (config.multiCohortSize <= 0) {
    return { cohortCount: 0, envelopeCount: 0 }
  }

  for (const participant of participants) {
    await participant.chat.watchScope(scope)
  }

  const coordinator = participants[0]
  const prepareResponse = await coordinator.device.httpClient.apiFetch(
    `/api/v1/room-crypto-topology/${scope.id}/prepare`,
    {
      method: 'POST',
      body: JSON.stringify({
        mode: 'multi_cohort',
        target_cohort_size: config.multiCohortSize,
        request_id: `load-migration:${scope.id}`
      })
    }
  )
  if (!prepareResponse.ok) {
    throw new Error(`Could not prepare multi-cohort load scope ${scope.id}: ${prepareResponse.status}`)
  }
  const { migration } = await prepareResponse.json()
  const topologies = await Promise.all(
    participants.map((participant) =>
      participant.device.client.fetchRoomCryptoTopology(scope.id, migration.id)
    )
  )
  const entries = participants.map((participant, index) => ({
    participant,
    topology: topologies[index]
  }))
  const cohorts = Map.groupBy(entries, (entry) => entry.topology.groupId)

  for (const members of cohorts.values()) {
    const [creator, ...peers] = members
    await waitFor(
      `load cohort creation ${creator.topology.groupId}`,
      async () => await creator.participant.chat.prepareCohortTopology(creator.topology, true),
      bootstrapTimeoutMs(config, members.length),
      100
    )
    for (const peer of peers) {
      await waitFor(
        `load cohort join ${peer.topology.groupId}`,
        async () => await peer.participant.chat.prepareCohortTopology(peer.topology, false),
        bootstrapTimeoutMs(config, peers.length),
        100
      )
    }
  }

  const coordinatorTopology = topologies[0]
  const staged = await coordinator.chat.coordinatePreparedRoomKeyEpoch(
    scope,
    coordinatorTopology,
    `load-room-key:${scope.id}:${migration.generation}`
  )
  const cutoverResponse = await coordinator.device.httpClient.apiFetch(
    `/api/v1/room-crypto-topology/${scope.id}/cutover`,
    {
      method: 'POST',
      body: JSON.stringify({ topology_id: migration.id })
    }
  )
  if (!cutoverResponse.ok) {
    throw new Error(`Could not cut over multi-cohort load scope ${scope.id}: ${cutoverResponse.status}`)
  }

  return {
    cohortCount: cohorts.size,
    envelopeCount: staged.envelopes.length
  }
}

async function provisionScenario(apiUrl, config) {
  const labelSlug = (config.label ?? 'default').replace(/[^a-z0-9]+/gi, '_').toLowerCase()
  const compactLabel = labelSlug.replace(/_/g, '')
  const labelSuffix =
    compactLabel.length > 6 ? `${compactLabel.slice(0, 4)}${compactLabel.slice(-2)}` : compactLabel || 'chaos'
  const nonce = Date.now().toString(36).slice(-6)
  const admin = createDeviceHarness(apiUrl, 'chaos-admin')
  const adminUsername = `sca_${labelSuffix}_${nonce}`
  const adminPassword = 'vesper-sdk-chaos-admin-password'
  await admin.register(adminUsername, adminPassword)
  const adminActor = createActor(admin, adminUsername, adminPassword, [], false)

  const server = await admin.createServer(`SDK Chaos ${Date.now()}`)
  const channels = [...server.channels]
  const targetChannelCount = Math.max(config.channelCount, config.activeChannelCount)

  for (let index = channels.length; index < targetChannelCount; index += 1) {
    const channel = await admin.createServerChannel(server.id, {
      name: `load-${index + 1}`,
      type: 'text'
    })
    channels.push(channel)
  }

  const activeChannels = channels.slice(0, Math.min(channels.length, config.activeChannelCount))

  const inviteCode = await admin.getServerInviteCode(server.id)
  const actors = []
  const expectedByScope = new Map(activeChannels.map((channel) => [channel.id, []]))
  const lastTouchedAtByScope = new Map()
  const assignmentPlan = buildScopeAssignments(
    activeChannels.map((channel) => channel.id),
    config.actualUsers + (config.secondaryEvery > 0 ? Math.ceil(config.actualUsers / config.secondaryEvery) : 0),
    config.scopesPerActor,
    config.scopeCohortSize
  )
  let assignmentIndex = 0

  for (let userIndex = 0; userIndex < config.actualUsers; userIndex += 1) {
    const username = `sc_${labelSuffix}_${nonce}_${userIndex.toString(36)}`
    const password = `sdk-chaos-password-${userIndex}`

    const primary = createDeviceHarness(apiUrl, `chaos-user-${userIndex}-primary`)
    await primary.register(username, password)
    await primary.joinServerByInvite(inviteCode)

    actors.push(
      createActor(
          primary,
          username,
          password,
          assignmentPlan[assignmentIndex] ?? [],
        false
      )
    )
    assignmentIndex += 1

    if (config.secondaryEvery > 0 && userIndex % config.secondaryEvery === 0) {
      const secondary = createDeviceHarness(apiUrl, `chaos-user-${userIndex}-secondary`)
      await approveAndUnlockSecondary(primary, secondary, username, password)
      await secondary.joinServerByInvite(inviteCode)

      actors.push(
        createActor(
            secondary,
            username,
            password,
            assignmentPlan[assignmentIndex] ?? [],
          true
        )
      )
      assignmentIndex += 1
    }
  }

  for (const actor of actors) {
    for (const scope of actor.scopes) {
      await actor.chat.watchScope(scope)
    }
  }

  const actorsByScope = new Map()
  for (const actor of actors) {
    for (const scope of actor.scopes) {
      const scopedActors = actorsByScope.get(scope.id) ?? []
      scopedActors.push(actor)
      actorsByScope.set(scope.id, scopedActors)
    }
  }

  const scale = {
    activeScopes: activeChannels.length,
    cohortCount: 0,
    envelopeCount: 0,
    physicalParticipants: actors.length + 1
  }

  for (const channel of activeChannels) {
    const scope = { kind: 'channel', id: channel.id }
    const scopedActors = actorsByScope.get(channel.id) ?? []

    if (scopedActors.length === 0) {
      continue
    }

    await adminActor.chat.watchScope(scope)
    await withTimeout(
      establishScopeViaNetwork(adminActor, scopedActors, scope, config),
      bootstrapTimeoutMs(config, scopedActors.length + 1),
      `bootstrap scope ${scope.id}`
    )

    await withTimeout(
      seedScopeHistory(scope, scopedActors, expectedByScope, config, {
        lastTouchedAtByScope
      }),
      seedTimeoutMs(config.historySeedMessages),
      `seed history for ${scope.id}`
    )

    const migration = await withTimeout(
      migrateScopeToMultiCohort(scope, [adminActor, ...actors], config),
      bootstrapTimeoutMs(config, actors.length + 1) * 4,
      `multi-cohort cutover ${scope.id}`
    )
    scale.cohortCount += migration.cohortCount
    scale.envelopeCount += migration.envelopeCount
  }

  return {
    admin,
    adminActor,
    actors,
    actorsByScope,
    fixture: null,
    expectedByScope,
    lastTouchedAtByScope,
    scale
  }
}

function readSharedFixture(config) {
  if (!config.sharedFixturePath) {
    return null
  }

  return JSON.parse(fs.readFileSync(config.sharedFixturePath, 'utf8'))
}

function sliceFixtureUsers(config, fixture) {
  const allUsers = fixture.users ?? []
  const start = Math.min(config.userOffset, allUsers.length)
  const end = Math.min(start + config.actualUsers, allUsers.length)
  return allUsers.slice(start, end)
}

function sliceFixtureActiveChannelIds(config, fixture) {
  const allActiveChannelIds = fixture.active_channel_ids ?? []
  const start = Math.min(config.activeChannelOffset, allActiveChannelIds.length)
  const end = Math.min(start + config.activeChannelCount, allActiveChannelIds.length)
  return allActiveChannelIds.slice(start, end)
}

function logProvisionProgress(label, current, total) {
  const interval = total >= 200 ? 50 : total >= 50 ? 10 : 5
  if (current === total || current === 1 || current % interval === 0) {
    console.log(`Chaos load: ${label} ${current}/${total}`)
  }
}

async function provisionSharedScenario(apiUrl, config) {
  const fixture = readSharedFixture(config)
  if (!fixture) {
    throw new Error('Missing shared fixture')
  }

  const selectedUsers = sliceFixtureUsers(config, fixture)
  const activeChannelIds = sliceFixtureActiveChannelIds(config, fixture)
  const actors = []
  const expectedByScope = new Map(activeChannelIds.map((channelId) => [channelId, []]))
  const lastTouchedAtByScope = new Map()
  const password = fixture.password
  const secondaryCount = selectedUsers.filter((user) => user.secondary_device_id).length
  const assignmentPlan = buildScopeAssignments(
    activeChannelIds,
    selectedUsers.length + secondaryCount,
    config.scopesPerActor,
    config.scopeCohortSize
  )
  let assignmentIndex = 0

  console.log(
    `Chaos load: shared fixture ${fixture.server.id} with ${fixture.user_count} users, ${fixture.channel_count} channels, ${activeChannelIds.length} active channels`
  )

  for (const [index, seededUser] of selectedUsers.entries()) {
    const primary = createDeviceHarness(apiUrl, `seeded-user-${config.userOffset + index}-primary`, {
      deviceId: seededUser.primary_device_id
    })
    const username = seededUser.username
    let primarySession = await primary.login(username, password)
    if (!primarySession.canUseE2EE && primarySession.currentDevice?.trust_state === 'trusted') {
      primarySession = await primary.unlockTrustedDevice(password)
    }
    if (!primarySession.canUseE2EE) {
      throw new Error(`Preseeded primary device could not unlock E2EE for ${username}`)
    }
    await primary.replenishKeyPackages()
    await waitForKeyPackages(primary)

    actors.push(
      createActor(
        primary,
        username,
        password,
        assignmentPlan[assignmentIndex] ?? [],
        false
      )
    )
    assignmentIndex += 1
    logProvisionProgress('logged in primaries', index + 1, selectedUsers.length)

    if (seededUser.secondary_device_id) {
      const secondary = createDeviceHarness(
        apiUrl,
        `seeded-user-${config.userOffset + index}-secondary`,
        {
          deviceId: seededUser.secondary_device_id
        }
      )
      let secondarySession = await secondary.login(username, password)
      if (!secondarySession.canUseE2EE && secondarySession.currentDevice?.trust_state === 'trusted') {
        secondarySession = await secondary.unlockTrustedDevice(password)
      }
      if (!secondarySession.canUseE2EE) {
        throw new Error(`Preseeded secondary device could not unlock E2EE for ${username}`)
      }
      await secondary.replenishKeyPackages()
      await waitForKeyPackages(secondary)

      actors.push(
        createActor(
          secondary,
          username,
          password,
          assignmentPlan[assignmentIndex] ?? [],
          true
        )
      )
      assignmentIndex += 1
    }
  }

  for (const [index, actor] of actors.entries()) {
    for (const scope of actor.scopes) {
      await actor.chat.watchScope(scope)
    }
    logProvisionProgress('watched actor scopes', index + 1, actors.length)
  }

  const actorsByScope = new Map()
  for (const actor of actors) {
    for (const scope of actor.scopes) {
      const scopedActors = actorsByScope.get(scope.id) ?? []
      scopedActors.push(actor)
      actorsByScope.set(scope.id, scopedActors)
    }
  }

  const scale = {
    activeScopes: 0,
    cohortCount: 0,
    envelopeCount: 0,
    physicalParticipants: actors.length
  }
  let bootstrappedScopes = 0
  for (const channelId of activeChannelIds) {
    const scope = { kind: 'channel', id: channelId }
    const scopedActors = actorsByScope.get(channelId) ?? []
    const [primaryActor, ...peers] = scopedActors

    if (!primaryActor) {
      continue
    }

    await withTimeout(
      establishScopeViaNetwork(primaryActor, peers, scope, config),
      bootstrapTimeoutMs(config, scopedActors.length),
      `bootstrap scope ${scope.id}`
    )

    await withTimeout(
      seedScopeHistory(scope, scopedActors, expectedByScope, config, {
        lastTouchedAtByScope
      }),
      seedTimeoutMs(config.historySeedMessages),
      `seed history for ${scope.id}`
    )

    const migration = await withTimeout(
      migrateScopeToMultiCohort(scope, scopedActors, config),
      bootstrapTimeoutMs(config, scopedActors.length) * 4,
      `multi-cohort cutover ${scope.id}`
    )
    scale.cohortCount += migration.cohortCount
    scale.envelopeCount += migration.envelopeCount
    scale.activeScopes += migration.cohortCount > 0 ? 1 : 0

    bootstrappedScopes += 1
    logProvisionProgress('bootstrapped active scopes', bootstrappedScopes, activeChannelIds.length)
  }

  return {
    admin: { disconnect() {} },
    actors,
    actorsByScope,
    expectedByScope,
    fixture,
    lastTouchedAtByScope,
    scale
  }
}

function selectConnectedActor(state) {
  return pickRandom(state.actors.filter((actor) => actor.connected))
}

function selectDisconnectedActor(state) {
  return pickRandom(state.actors.filter((actor) => !actor.connected))
}

function selectTrustedActor(state) {
  return pickRandom(state.actors.filter((actor) => actor.connected && actor.trustedSecondary))
}

function selectScope(actor) {
  return pickRandom(actor.scopes)
}

function selectScopesForWideRestore(actor, state, count) {
  if (actor.scopes.length <= count) {
    return [...actor.scopes]
  }

  const rankedScopes = [...actor.scopes].sort((left, right) => {
    const leftTouchedAt = state.lastTouchedAtByScope.get(left.id) ?? 0
    const rightTouchedAt = state.lastTouchedAtByScope.get(right.id) ?? 0
    return leftTouchedAt - rightTouchedAt
  })

  if (count <= 1) {
    return rankedScopes.at(-1) ? [rankedScopes.at(-1)] : []
  }

  const coldestScope = rankedScopes[0] ?? null
  const hottestScope = rankedScopes.at(-1) ?? null
  const selected = []
  const seen = new Set()

  for (const scope of [coldestScope, hottestScope]) {
    if (!scope || seen.has(scope.id)) {
      continue
    }

    selected.push(scope)
    seen.add(scope.id)
  }

  while (selected.length < Math.min(count, actor.scopes.length)) {
    const scope = selectScope(actor)
    if (!scope || seen.has(scope.id)) {
      continue
    }

    selected.push(scope)
    seen.add(scope.id)
  }

  return selected
}

function validateRestore(state, actor, scopeId, result, metrics) {
  for (const event of result.events) {
    if (!/(repair|resync)/i.test(event.eventType)) {
      continue
    }
    const key = `${scopeId}:${event.id ?? event.insertedAt}:${event.eventType}`
    if (!metrics.repairEventKeys.has(key)) {
      metrics.repairEventKeys.add(key)
      metrics.repairEvents += 1
    }
  }

  for (const message of result.messages) {
    if (message.decryptionFailed) {
      const failureKey = `${scopeId}:${message.id}`
      if (metrics.decryptFailureKeys.has(failureKey)) {
        continue
      }

      metrics.decryptFailureKeys.add(failureKey)
      metrics.decryptFailures += 1
      if (metrics.decryptFailureSamples.length < 5) {
        metrics.decryptFailureSamples.push(
          [
            actor.username,
            actor.device.deviceIdentity.id,
            scopeId,
            message.id,
            `scheme=${message.raw.encryption_scheme ?? 'mls'}`,
            `group=${message.raw.encryption_group_id ?? 'scope'}`,
            `epoch=${message.raw.mls_epoch ?? 'none'}`,
            `sender=${message.raw.sender_id ?? 'unknown'}`
          ].join(':')
        )
      }
    }
  }

  const expected = state.expectedByScope.get(scopeId) ?? []
  if (expected.length === 0) {
    return
  }

  const contents = result.messages.map((message) => message.content)
  if (!expected.some((value) => contents.includes(value))) {
    metrics.restoreMisses += 1
  }
}

async function reconnectActor(actor) {
  actor.chat = createChatHarness(actor.device)
  for (const scope of actor.scopes) {
    await actor.chat.watchScope(scope)
  }
  actor.connected = true
}

async function restoreScope(actor, scope, config) {
  const pageSize = Math.max(1, Math.min(config.restorePageSize, config.restoreBatchSize))
  const maxPages = Math.max(1, Math.ceil(config.restoreBatchSize / pageSize))

  const result = await actor.chat.syncScopePaginated(scope, {
    maxPages,
    pageSize
  })
  actor.scopeQueryCount += result.pagesFetched
  return result
}

async function performSend(state, config, metrics, logicalWeight, serialRef) {
  const actor = selectConnectedActor(state)
  if (!actor) {
    return
  }

  const scope = selectScope(actor)
  if (!scope) {
    return
  }

  const text = `load:${serialRef.value}:${Date.now()}`
  const shouldSampleDelivery =
    config.deliverySampleEvery > 0 && serialRef.value % config.deliverySampleEvery === 0
  serialRef.value += 1
  const deliveryRecipient = shouldSampleDelivery
    ? selectDeliveryRecipient(state, actor, scope)
    : null

  const startedAt = performance.now()
  await actor.chat.sendText(scope, text)
  metrics.messagesSent += 1
  metrics.applicationFanoutPublishes += 1
  const ackDurationMs = performance.now() - startedAt
  recordMetric(metrics, 'sendAck', ackDurationMs, logicalWeight)

  if (deliveryRecipient) {
    const delivered = await deliveryRecipient.chat.waitForMessage(
      scope.id,
      (message) => message.content === text && message.senderUsername === actor.username,
      config.deliveryTimeoutMs
    )
    if (delivered) {
      recordMetric(metrics, 'deliveryE2E', performance.now() - startedAt, logicalWeight)
    }
  }

  pushRing(state.expectedByScope, scope.id, text, config.expectedWindow)
  touchScope(state, scope.id)
}

function selectDeliveryRecipient(state, sender, scope) {
  const scopeActors = state.actorsByScope.get(scope.id) ?? []
  return pickRandom(
    scopeActors.filter((actor) => actor.connected && actor !== sender)
  )
}

async function performDisconnect(state) {
  const actor = selectConnectedActor(state)
  if (!actor) {
    return
  }

  actor.chat.disconnect()
  actor.connected = false
}

async function performReconnect(state, config, metrics, logicalWeight) {
  const actor = selectDisconnectedActor(state)
  if (!actor) {
    return
  }
  const scopes = selectScopesForWideRestore(actor, state, Math.min(2, config.wideRestoreScopes))
  if (scopes.length === 0) {
    return
  }

  const startedAt = performance.now()
  await reconnectActor(actor)
  for (const scope of scopes) {
    const result = await restoreScope(actor, scope, config)
    validateRestore(state, actor, scope.id, result, metrics)
  }
  recordMetric(metrics, 'reconnectRestore', performance.now() - startedAt, logicalWeight)
}

async function performSync(state, config, metrics, logicalWeight) {
  const actor = selectConnectedActor(state)
  if (!actor) {
    return
  }

  const scope = selectScope(actor)
  if (!scope) {
    return
  }

  const startedAt = performance.now()
  const result = await restoreScope(actor, scope, config)
  recordMetric(metrics, 'syncRestore', performance.now() - startedAt, logicalWeight)
  validateRestore(state, actor, scope.id, result, metrics)
}

async function performWideRestore(state, config, metrics, logicalWeight) {
  const actor = selectConnectedActor(state)
  if (!actor) {
    return
  }

  const scopes = selectScopesForWideRestore(actor, state, config.wideRestoreScopes)
  if (scopes.length === 0) {
    return
  }

  const startedAt = performance.now()
  for (const scope of scopes) {
    const result = await restoreScope(actor, scope, config)
    validateRestore(state, actor, scope.id, result, metrics)
  }
  recordMetric(metrics, 'wideRestore', performance.now() - startedAt, logicalWeight)
}

async function performLoginRestore(state, config, metrics, logicalWeight) {
  const actor = selectTrustedActor(state)
  if (!actor) {
    return
  }

  actor.chat.disconnect()
  await actor.device.logout()
  const session = await actor.device.login(actor.username, actor.password)
  if (!session.canUseE2EE) {
    throw new Error(`Trusted login restore came back without E2EE for ${actor.username}`)
  }

  const scopes = selectScopesForWideRestore(actor, state, Math.min(2, config.wideRestoreScopes))
  if (scopes.length === 0) {
    return
  }

  const startedAt = performance.now()
  await reconnectActor(actor)
  for (const scope of scopes) {
    const result = await restoreScope(actor, scope, config)
    validateRestore(state, actor, scope.id, result, metrics)
  }
  recordMetric(metrics, 'loginRestore', performance.now() - startedAt, logicalWeight)
}

async function auditState(state, config, metrics, logicalWeight) {
  const targets = state.actors.filter((actor) => actor.connected).slice(0, config.auditSamples)

  for (const actor of targets) {
    const scope = selectScope(actor)
    if (!scope) {
      continue
    }

    try {
      const startedAt = performance.now()
      const result = await withTimeout(
        restoreScope(actor, scope, config),
        4_000,
        'audit sync'
      )
      recordMetric(metrics, 'auditSync', performance.now() - startedAt, logicalWeight)
      validateRestore(state, actor, scope.id, result, metrics)
    } catch (error) {
      recordFailure(metrics, 'audit sync', error)
    }
  }
}

async function run() {
  const config = readConfig()
  const startedAt = performance.now()
  const stack = config.apiUrl ? null : await bootServerStack()
  let state = null

  try {
    const apiUrl = config.apiUrl ?? stack?.apiUrl
    if (!apiUrl) {
      throw new Error('Missing chaos API URL')
    }

    state = config.sharedFixturePath
      ? await provisionSharedScenario(apiUrl, config)
      : await provisionScenario(apiUrl, config)
    console.log(`Chaos load: provisioned ${state.actors.length} actors`)
    const metrics = createMetrics()
    const logicalWeight = config.simulatedUsers / Math.max(config.actualUsers, 1)
    const deadline = Date.now() + config.durationSeconds * 1000
    const serialRef = { value: 0 }

    console.log('Chaos load: timed phase starting')
    while (Date.now() < deadline) {
      const roll = Math.random()

      try {
        if (roll < 0.55) {
          await withTimeout(
            performSend(state, config, metrics, logicalWeight, serialRef),
            4_000,
            'send'
          )
        } else if (roll < 0.68) {
          await performDisconnect(state)
        } else if (roll < 0.82) {
          await withTimeout(
            performReconnect(state, config, metrics, logicalWeight),
            4_000,
            'reconnect restore'
          )
        } else if (roll < 0.90) {
          await withTimeout(
            performSync(state, config, metrics, logicalWeight),
            4_000,
            'sync restore'
          )
        } else if (roll < 0.97) {
          await withTimeout(
            performWideRestore(state, config, metrics, logicalWeight),
            8_000,
            'wide restore'
          )
        } else if (config.loginRestoreEnabled) {
          await withTimeout(
            performLoginRestore(state, config, metrics, logicalWeight),
            5_000,
            'login restore'
          )
        } else {
          await withTimeout(
            performSync(state, config, metrics, logicalWeight),
            4_000,
            'sync restore'
          )
        }
      } catch (error) {
        recordFailure(metrics, 'timed operation', error)
      }
    }

    console.log('Chaos load: timed phase complete')
    await auditState(state, config, metrics, logicalWeight)
    console.log('Chaos load: audit complete')
    const scaleMetrics = buildScaleMetrics(state, metrics)
    const summaries = summarizeMetrics(
      metrics,
      config,
      state.actors.length,
      performance.now() - startedAt,
      scaleMetrics
    )
    const report = buildReport(
      config,
      state.actors.length,
      performance.now() - startedAt,
      metrics,
      summaries,
      scaleMetrics
    )
    writeJsonReport(config.jsonOutputPath, report)

    const missedTarget = Object.values(summaries).some((summary) => {
      return summary.p95 != null && summary.p95 > config.targetLatencyMs
    })

    if (metrics.failures > 0 || metrics.decryptFailures > 0 || missedTarget) {
      process.exitCode = 1
    }
  } finally {
    shuttingDown = true

    if (state) {
      for (const actor of state.actors) {
        actor.chat.disconnect()
        actor.device.disconnect()
      }

      state.adminActor?.chat.disconnect()
      if (!state.adminActor) {
        state.admin.disconnect()
      }
      await waitInterval(250)
    }

    if (stack) {
      await teardownServerStack(stack)
    }
  }
}

await run()
