import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bootServerStack,
  createChatHarness,
  createDeviceHarness,
  teardownServerStack
} from '../dist/testing/index.js'

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function waitFor(description, predicate, timeoutMs = 8_000, intervalMs = 100) {
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

    await sleep(intervalMs)
  }

  throw lastError ?? new Error(`Timed out waiting for ${description}`)
}

async function approveAndUnlockSecondary(primary, secondary, username, password) {
  const secondarySession = await secondary.login(username, password)
  assert.equal(secondarySession.currentDevice?.trust_state, 'pending')
  assert.equal(secondarySession.canUseE2EE, false)

  const pendingDevice = await waitFor('secondary device to appear as pending', async () => {
    const state = await primary.fetchDevices()
    return (
      state.devices.find((device) => device.client_id === secondary.deviceIdentity.id) ?? null
    )
  })

  assert.equal(pendingDevice.trust_state, 'pending')
  await primary.approveDevice(pendingDevice.id)

  await waitFor('secondary device to become trusted', async () => {
    const state = await secondary.fetchDevices()
    return state.currentDevice?.trust_state === 'trusted' ? state : null
  })

  const unlocked = await secondary.unlockTrustedDevice(password)
  assert.equal(unlocked.canUseE2EE, true)
}

async function createGeneralChannel(primary, serverName) {
  const server = await primary.createServer(serverName)
  const generalChannel =
    server.channels.find((channel) => channel.name === 'general') ?? null

  assert.ok(generalChannel, 'expected the default general channel to exist')

  return {
    channel: generalChannel,
    server
  }
}

async function establishScope(primaryChat, peers, scope) {
  await primaryChat.watchScope(scope)
  for (const peer of peers) {
    await peer.watchScope(scope)
  }

  await primaryChat.createScopeGroup(scope)

  const establishedMembers = [primaryChat]

  for (const peer of peers) {
    await peer.device.replenishKeyPackages()

    const joinPackage = await primaryChat.generateJoinPackage(
      scope,
      peer.device.requireSession().user.id,
      peer.device.deviceIdentity.id
    )

    assert.ok(joinPackage, `expected a join package for ${peer.device.deviceIdentity.id}`)

    for (const member of establishedMembers.slice(1)) {
      const committed = await member.applyCommitPacket(scope, joinPackage.commitBytes)
      assert.equal(committed, true)
    }

    const welcomed = await peer.applyWelcomePackage(
      scope,
      joinPackage.welcomeBytes,
      joinPackage.keyPackageRef
    )
    assert.equal(welcomed, true)

    establishedMembers.push(peer)
  }

  const created = await primaryChat.ensureScopeReady(scope, false)
  assert.equal(created, true)

  for (const peer of peers) {
    const ready = await peer.ensureScopeReady(scope, false)
    assert.equal(ready, true)
  }
}

function assertNoDecryptFailures(messages, label) {
  assert.equal(
    messages.some((message) => message.decryptionFailed),
    false,
    `${label} should not contain undecryptable messages`
  )
}

function assertMessageDecrypts(messages, expectedText, label) {
  const message = messages.find((entry) => entry.content === expectedText) ?? null
  assert.ok(message, `${label} should include "${expectedText}"`)
  assert.equal(message.decryptionFailed, false, `${label} should decrypt "${expectedText}"`)
}

function assertMessageTexts(messages, expectedTexts) {
  const actualTexts = messages.map((message) => message.content)
  for (const expectedText of expectedTexts) {
    assert.ok(
      actualTexts.includes(expectedText),
      `expected synced messages to include "${expectedText}", got ${JSON.stringify(actualTexts)}`
    )
  }
}

async function syncUntilMessages(chat, scope, expectedTexts, options = {}) {
  const limit = options.limit ?? 50

  return await waitFor(
    `messages ${expectedTexts.join(', ')} to appear in ${scope.kind}:${scope.id}`,
    async () => {
      const result = await chat.syncScope(scope, { limit })
      const contents = result.messages.map((message) => message.content)
      return expectedTexts.every((text) => contents.includes(text)) ? result : null
    },
    options.timeoutMs ?? 10_000,
    options.intervalMs ?? 150
  )
}

async function syncUntilHealthy(chat, scope, expectedTexts, options = {}) {
  const limit = options.limit ?? 50

  return await waitFor(
    `healthy decrypted messages ${expectedTexts.join(', ')} in ${scope.kind}:${scope.id}`,
    async () => {
      const result = await chat.syncScope(scope, { limit })
      const contents = result.messages.map((message) => message.content)
      const allPresent = expectedTexts.every((text) => contents.includes(text))
      const healthy = !result.messages.some((message) => message.decryptionFailed)
      return allPresent && healthy ? result : null
    },
    options.timeoutMs ?? 10_000,
    options.intervalMs ?? 150
  )
}

async function sendBurst(chatHarnesses, scope, prefix, count) {
  const sent = []

  for (let index = 0; index < count; index += 1) {
    const text = `${prefix}-${index}`
    const sender = chatHarnesses[index % chatHarnesses.length]
    await sender.sendText(scope, text)
    sent.push(text)
  }

  return sent
}

async function createDirectConversation(primary, otherUserId) {
  const conversation = await primary.createConversation([otherUserId])
  return { kind: 'dm', id: conversation.id }
}

async function waitForServerMembership(device, serverId, expectedPresent) {
  return await waitFor(
    `server ${serverId} membership to become ${expectedPresent ? 'present' : 'absent'}`,
    async () => {
      const servers = await device.listServers()
      const present = servers.some((server) => server.id === serverId)
      return present === expectedPresent ? servers : null
    },
    10_000,
    150
  )
}

async function assertNoLiveMessage(chat, scopeId, expectedText, timeoutMs = 750) {
  await assert.rejects(
    chat.waitForMessage(scopeId, (message) => message.content === expectedText, timeoutMs),
    /Timed out waiting for a message/
  )
}

test('sdk multi-device chaos coverage keeps encrypted sync fast and recoverable', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(() => {
    teardownServerStack(stack)
  })

  await t.test('same-user offline catch-up decrypts the latest channel message in under 20ms', async () => {
    const username = `sdk_chaos_hot_${Date.now()}`
    const password = 'vesper-sdk-chaos-password'
    const primary = createDeviceHarness(stack.apiUrl, 'hot-primary')
    const secondary = createDeviceHarness(stack.apiUrl, 'hot-secondary')
    const primaryChat = createChatHarness(primary)
    const secondaryChat = createChatHarness(secondary)

    try {
      await primary.register(username, password)
      await approveAndUnlockSecondary(primary, secondary, username, password)

      const { channel } = await createGeneralChannel(primary, `Chaos Hot ${Date.now()}`)
      const scope = { kind: 'channel', id: channel.id }

      await establishScope(primaryChat, [secondaryChat], scope)

      secondaryChat.disconnect()
      await primaryChat.sendText(scope, 'offline hello 1')
      await primaryChat.sendText(scope, 'offline hello 2')

      const latestSync = await secondaryChat.syncScope(scope, { limit: 1 })
      assert.ok(
        latestSync.durationMs < 20,
        `expected latest-message sync to stay under 20ms, got ${latestSync.durationMs.toFixed(2)}ms`
      )

      const backlogSync = await secondaryChat.syncScope(scope, { limit: 10 })
      assertMessageTexts(backlogSync.messages, ['offline hello 1', 'offline hello 2'])
      assertNoDecryptFailures(backlogSync.messages, 'offline catch-up')
    } finally {
      primaryChat.disconnect()
      secondaryChat.disconnect()
    }
  })

  await t.test('logout and later login on a trusted device preserves channel decryptability', async () => {
    const username = `sdk_chaos_reauth_${Date.now()}`
    const password = 'vesper-sdk-relogin-password'
    const primary = createDeviceHarness(stack.apiUrl, 'reauth-primary')
    const secondary = createDeviceHarness(stack.apiUrl, 'reauth-secondary')
    const tertiary = createDeviceHarness(stack.apiUrl, 'reauth-tertiary')
    const primaryChat = createChatHarness(primary)
    const secondaryChat = createChatHarness(secondary)
    const tertiaryChat = createChatHarness(tertiary)

    try {
      await primary.register(username, password)
      await approveAndUnlockSecondary(primary, secondary, username, password)
      await approveAndUnlockSecondary(primary, tertiary, username, password)

      const { channel } = await createGeneralChannel(primary, `Chaos Reauth ${Date.now()}`)
      const scope = { kind: 'channel', id: channel.id }

      await establishScope(primaryChat, [secondaryChat, tertiaryChat], scope)

      await primaryChat.sendText(scope, 'device-one')
      await secondaryChat.sendText(scope, 'device-two')
      await tertiaryChat.sendText(scope, 'device-three')

      secondaryChat.disconnect()
      await secondary.logout()

      await primaryChat.sendText(scope, 'after-logout')
      await tertiaryChat.sendText(scope, 'after-tertiary')

      const relogged = await secondary.login(username, password)
      assert.equal(relogged.currentDevice?.trust_state, 'trusted')
      assert.equal(relogged.canUseE2EE, true)

      const resumedSecondaryChat = createChatHarness(secondary)
      const fullSync = await resumedSecondaryChat.syncScope(scope, { limit: 20 })
      assertMessageTexts(fullSync.messages, [
        'device-one',
        'device-two',
        'device-three',
        'after-logout',
        'after-tertiary'
      ])
      assertNoDecryptFailures(fullSync.messages, 'trusted relogin catch-up')

      resumedSecondaryChat.disconnect()
    } finally {
      primaryChat.disconnect()
      secondaryChat.disconnect()
      tertiaryChat.disconnect()
    }
  })

  await t.test('a second user can share a channel while another device catches up from offline', async () => {
    const base = Date.now()
    const ownerUsername = `sdk_chaos_owner_${base}`
    const ownerPassword = 'vesper-sdk-owner-password'
    const guestUsername = `sdk_chaos_guest_${base}`
    const guestPassword = 'vesper-sdk-guest-password'

    const ownerPrimary = createDeviceHarness(stack.apiUrl, 'owner-primary')
    const ownerSecondary = createDeviceHarness(stack.apiUrl, 'owner-secondary')
    const guestPrimary = createDeviceHarness(stack.apiUrl, 'guest-primary')

    const ownerPrimaryChat = createChatHarness(ownerPrimary)
    const ownerSecondaryChat = createChatHarness(ownerSecondary)
    const guestPrimaryChat = createChatHarness(guestPrimary)

    try {
      await ownerPrimary.register(ownerUsername, ownerPassword)
      await approveAndUnlockSecondary(
        ownerPrimary,
        ownerSecondary,
        ownerUsername,
        ownerPassword
      )

      await guestPrimary.register(guestUsername, guestPassword)

      const { channel, server } = await createGeneralChannel(
        ownerPrimary,
        `Chaos Shared ${Date.now()}`
      )
      const inviteCode = await ownerPrimary.getServerInviteCode(server.id)
      await guestPrimary.joinServerByInvite(inviteCode)

      const scope = { kind: 'channel', id: channel.id }
      await establishScope(ownerPrimaryChat, [ownerSecondaryChat, guestPrimaryChat], scope)

      ownerSecondaryChat.disconnect()

      await guestPrimaryChat.sendText(scope, 'guest says hi')
      await ownerPrimaryChat.sendText(scope, 'owner replies')
      await guestPrimaryChat.sendText(scope, 'guest follow-up')

      const backlogSync = await ownerSecondaryChat.syncScope(scope, { limit: 10 })
      assertMessageTexts(backlogSync.messages, [
        'guest says hi',
        'owner replies',
        'guest follow-up'
      ])
      assertNoDecryptFailures(backlogSync.messages, 'shared-channel catch-up')
    } finally {
      ownerPrimaryChat.disconnect()
      ownerSecondaryChat.disconnect()
      guestPrimaryChat.disconnect()
    }
  })

  await t.test('multiple trusted devices can split between online and offline states across long and short channel histories', async () => {
    const username = `sdk_chaos_matrix_${Date.now()}`
    const password = 'vesper-sdk-matrix-password'

    const primary = createDeviceHarness(stack.apiUrl, 'matrix-primary')
    const secondaryA = createDeviceHarness(stack.apiUrl, 'matrix-secondary-a')
    const secondaryB = createDeviceHarness(stack.apiUrl, 'matrix-secondary-b')
    const secondaryC = createDeviceHarness(stack.apiUrl, 'matrix-secondary-c')

    const primaryChat = createChatHarness(primary)
    const secondaryAChat = createChatHarness(secondaryA)
    const secondaryBChat = createChatHarness(secondaryB)
    const secondaryCChat = createChatHarness(secondaryC)

    try {
      await primary.register(username, password)
      await approveAndUnlockSecondary(primary, secondaryA, username, password)
      await approveAndUnlockSecondary(primary, secondaryB, username, password)
      await approveAndUnlockSecondary(primary, secondaryC, username, password)

      const { channel } = await createGeneralChannel(primary, `Chaos Matrix ${Date.now()}`)
      const scope = { kind: 'channel', id: channel.id }

      await establishScope(primaryChat, [secondaryAChat, secondaryBChat, secondaryCChat], scope)

      secondaryBChat.disconnect()
      secondaryCChat.disconnect()

      const longBurst = await sendBurst([primaryChat], scope, 'matrix-long', 36)

      const liveMessage = await secondaryAChat.waitForMessage(
        scope.id,
        (message) => message.content === longBurst[35]
      )
      assert.equal(liveMessage.content, longBurst[35])
      secondaryAChat.disconnect()

      const healthySecondaryBCatchup = await syncUntilHealthy(
        secondaryBChat,
        scope,
        [longBurst[0], longBurst[18], longBurst[35]],
        { limit: 120 }
      )
      assertNoDecryptFailures(
        healthySecondaryBCatchup.messages,
        'secondary B long history restore'
      )

      const shortBurst = await sendBurst([primaryChat], scope, 'matrix-short', 4)

      const secondaryCCatchup = await syncUntilHealthy(
        secondaryCChat,
        scope,
        [shortBurst[0], shortBurst[3], longBurst[35]],
        { limit: 120 }
      )
      assertNoDecryptFailures(secondaryCCatchup.messages, 'secondary C mixed restore')

      secondaryAChat.disconnect()
      await primaryChat.sendText(scope, 'matrix-final-live')
      await primaryChat.sendText(scope, 'matrix-final-tail')

      const resumedSecondaryAChat = createChatHarness(secondaryA)
      const resumedSync = await syncUntilHealthy(
        resumedSecondaryAChat,
        scope,
        ['matrix-final-live', 'matrix-final-tail', shortBurst[3]],
        { limit: 120 }
      )
      assertNoDecryptFailures(resumedSync.messages, 'secondary A resumed restore')

      resumedSecondaryAChat.disconnect()
    } finally {
      primaryChat.disconnect()
      secondaryAChat.disconnect()
      secondaryBChat.disconnect()
      secondaryCChat.disconnect()
    }
  })

  await t.test('alternating trusted devices preserve decryptability for an offline long channel backlog', async () => {
    const username = `sdk_chaos_alt_${Date.now()}`
    const password = 'vesper-sdk-alt-password'

    const primary = createDeviceHarness(stack.apiUrl, 'alt-primary')
    const secondaryA = createDeviceHarness(stack.apiUrl, 'alt-secondary-a')
    const secondaryB = createDeviceHarness(stack.apiUrl, 'alt-secondary-b')
    const secondaryC = createDeviceHarness(stack.apiUrl, 'alt-secondary-c')

    const primaryChat = createChatHarness(primary)
    const secondaryAChat = createChatHarness(secondaryA)
    const secondaryBChat = createChatHarness(secondaryB)
    const secondaryCChat = createChatHarness(secondaryC)

    try {
      await primary.register(username, password)
      await approveAndUnlockSecondary(primary, secondaryA, username, password)
      await approveAndUnlockSecondary(primary, secondaryB, username, password)
      await approveAndUnlockSecondary(primary, secondaryC, username, password)

      const { channel } = await createGeneralChannel(primary, `Chaos Alt ${Date.now()}`)
      const scope = { kind: 'channel', id: channel.id }

      await establishScope(primaryChat, [secondaryAChat, secondaryBChat, secondaryCChat], scope)

      secondaryBChat.disconnect()
      secondaryCChat.disconnect()

      const alternatingBurst = await sendBurst(
        [primaryChat, secondaryAChat],
        scope,
        'matrix-alt',
        32
      )

      const offlineRestore = await syncUntilHealthy(
        secondaryBChat,
        scope,
        [alternatingBurst[0], alternatingBurst[15], alternatingBurst[31]],
        { limit: 120, timeoutMs: 12_000 }
      )
      assertNoDecryptFailures(offlineRestore.messages, 'alternating multi-sender restore')

      const resumedSecondaryCChat = createChatHarness(secondaryC)
      const resumedRestore = await syncUntilHealthy(
        resumedSecondaryCChat,
        scope,
        [alternatingBurst[3], alternatingBurst[16], alternatingBurst[30]],
        { limit: 120, timeoutMs: 12_000 }
      )
      assertNoDecryptFailures(resumedRestore.messages, 'alternating resumed restore')

      resumedSecondaryCChat.disconnect()
    } finally {
      primaryChat.disconnect()
      secondaryAChat.disconnect()
      secondaryBChat.disconnect()
      secondaryCChat.disconnect()
    }
  })

  await t.test('cross-user direct message histories restore across trusted relogin and staggered offline devices', async () => {
    const base = Date.now()
    const ownerUsername = `sdk_chaos_dm_owner_${base}`
    const ownerPassword = 'vesper-sdk-dm-owner-password'
    const guestUsername = `sdk_chaos_dm_guest_${base}`
    const guestPassword = 'vesper-sdk-dm-guest-password'

    const ownerPrimary = createDeviceHarness(stack.apiUrl, 'dm-owner-primary')
    const ownerSecondary = createDeviceHarness(stack.apiUrl, 'dm-owner-secondary')
    const guestPrimary = createDeviceHarness(stack.apiUrl, 'dm-guest-primary')
    const guestSecondary = createDeviceHarness(stack.apiUrl, 'dm-guest-secondary')

    const ownerPrimaryChat = createChatHarness(ownerPrimary)
    const ownerSecondaryChat = createChatHarness(ownerSecondary)
    const guestPrimaryChat = createChatHarness(guestPrimary)
    const guestSecondaryChat = createChatHarness(guestSecondary)

    try {
      await ownerPrimary.register(ownerUsername, ownerPassword)
      await approveAndUnlockSecondary(
        ownerPrimary,
        ownerSecondary,
        ownerUsername,
        ownerPassword
      )

      await guestPrimary.register(guestUsername, guestPassword)
      await approveAndUnlockSecondary(
        guestPrimary,
        guestSecondary,
        guestUsername,
        guestPassword
      )

      const guestUser = await guestPrimary.getCurrentUser()
      const scope = await createDirectConversation(ownerPrimary, guestUser.id)

      await establishScope(ownerPrimaryChat, [ownerSecondaryChat, guestPrimaryChat, guestSecondaryChat], scope)

      ownerSecondaryChat.disconnect()
      guestSecondaryChat.disconnect()

      const longDmBurst = await sendBurst([ownerPrimaryChat], scope, 'dm-long', 24)

      const ownerSecondarySync = await syncUntilHealthy(
        ownerSecondaryChat,
        scope,
        [longDmBurst[0], longDmBurst[12], longDmBurst[23]],
        { limit: 80, timeoutMs: 12_000 }
      )
      assertNoDecryptFailures(ownerSecondarySync.messages, 'owner secondary DM restore')

      await guestSecondary.logout()
      await ownerPrimaryChat.sendText(scope, 'dm-after-logout')
      await guestPrimaryChat.sendText(scope, 'dm-after-guest-reply')

      const reloggedGuest = await guestSecondary.login(guestUsername, guestPassword)
      assert.equal(reloggedGuest.currentDevice?.trust_state, 'trusted')
      assert.equal(reloggedGuest.canUseE2EE, true)

      const resumedGuestSecondaryChat = createChatHarness(guestSecondary)
      const guestSecondarySync = await syncUntilHealthy(
        resumedGuestSecondaryChat,
        scope,
        ['dm-after-logout', 'dm-after-guest-reply', longDmBurst[23]],
        { limit: 100, timeoutMs: 12_000 }
      )
      assertNoDecryptFailures(guestSecondarySync.messages, 'guest secondary DM relogin restore')

      resumedGuestSecondaryChat.disconnect()
    } finally {
      ownerPrimaryChat.disconnect()
      guestPrimaryChat.disconnect()
      ownerSecondaryChat.disconnect()
      guestSecondaryChat.disconnect()
    }
  })

  await t.test('one offline device can recover mixed channel and DM traffic across reconnect churn', async () => {
    const base = Date.now()
    const ownerUsername = `sdk_mix_owner_${base}`
    const ownerPassword = 'vesper-sdk-mix-owner-password'
    const guestUsername = `sdk_mix_guest_${base}`
    const guestPassword = 'vesper-sdk-mix-guest-password'

    const ownerPrimary = createDeviceHarness(stack.apiUrl, 'mix-owner-primary')
    const ownerSecondary = createDeviceHarness(stack.apiUrl, 'mix-owner-secondary')
    const guestPrimary = createDeviceHarness(stack.apiUrl, 'mix-guest-primary')

    const ownerPrimaryChat = createChatHarness(ownerPrimary)
    const ownerSecondaryChat = createChatHarness(ownerSecondary)
    const guestPrimaryChat = createChatHarness(guestPrimary)

    try {
      await ownerPrimary.register(ownerUsername, ownerPassword)
      await approveAndUnlockSecondary(
        ownerPrimary,
        ownerSecondary,
        ownerUsername,
        ownerPassword
      )

      await guestPrimary.register(guestUsername, guestPassword)

      const { channel, server } = await createGeneralChannel(
        ownerPrimary,
        `Chaos Mixed ${Date.now()}`
      )
      const inviteCode = await ownerPrimary.getServerInviteCode(server.id)
      await guestPrimary.joinServerByInvite(inviteCode)

      const guestUser = await guestPrimary.getCurrentUser()
      const dmScope = await createDirectConversation(ownerPrimary, guestUser.id)
      const channelScope = { kind: 'channel', id: channel.id }

      await establishScope(ownerPrimaryChat, [ownerSecondaryChat, guestPrimaryChat], channelScope)
      await establishScope(ownerPrimaryChat, [ownerSecondaryChat, guestPrimaryChat], dmScope)

      ownerSecondaryChat.disconnect()

      await ownerPrimaryChat.sendText(channelScope, 'mix-channel-round-1-owner')
      await guestPrimaryChat.sendText(dmScope, 'mix-dm-round-1-guest')
      await guestPrimaryChat.sendText(channelScope, 'mix-channel-round-1-guest')
      await ownerPrimaryChat.sendText(dmScope, 'mix-dm-round-1-owner')

      const firstChannelRestore = await syncUntilHealthy(
        ownerSecondaryChat,
        channelScope,
        ['mix-channel-round-1-owner', 'mix-channel-round-1-guest'],
        { limit: 40, timeoutMs: 12_000 }
      )
      assertNoDecryptFailures(firstChannelRestore.messages, 'mixed channel restore round 1')

      const firstDmRestore = await syncUntilHealthy(
        ownerSecondaryChat,
        dmScope,
        ['mix-dm-round-1-owner', 'mix-dm-round-1-guest'],
        { limit: 40, timeoutMs: 12_000 }
      )
      assertNoDecryptFailures(firstDmRestore.messages, 'mixed dm restore round 1')

      const resumedOwnerSecondaryChat = createChatHarness(ownerSecondary)
      await resumedOwnerSecondaryChat.watchScope(channelScope)
      await resumedOwnerSecondaryChat.watchScope(dmScope)

      await ownerPrimaryChat.sendText(channelScope, 'mix-channel-round-2-owner')
      await guestPrimaryChat.sendText(dmScope, 'mix-dm-round-2-guest')

      const secondChannelRestore = await syncUntilHealthy(
        resumedOwnerSecondaryChat,
        channelScope,
        ['mix-channel-round-2-owner', 'mix-channel-round-1-owner', 'mix-channel-round-1-guest'],
        { limit: 60, timeoutMs: 12_000 }
      )
      assertNoDecryptFailures(secondChannelRestore.messages, 'mixed channel restore round 2')

      const secondDmRestore = await syncUntilHealthy(
        resumedOwnerSecondaryChat,
        dmScope,
        ['mix-dm-round-2-guest', 'mix-dm-round-1-owner', 'mix-dm-round-1-guest'],
        { limit: 60, timeoutMs: 12_000 }
      )
      assertNoDecryptFailures(secondDmRestore.messages, 'mixed dm restore round 2')

      resumedOwnerSecondaryChat.disconnect()

      await guestPrimaryChat.sendText(channelScope, 'mix-channel-round-3-guest')
      await ownerPrimaryChat.sendText(dmScope, 'mix-dm-round-3-owner')

      const finalOwnerSecondaryChat = createChatHarness(ownerSecondary)
      const finalChannelRestore = await syncUntilHealthy(
        finalOwnerSecondaryChat,
        channelScope,
        [
          'mix-channel-round-1-owner',
          'mix-channel-round-1-guest',
          'mix-channel-round-2-owner',
          'mix-channel-round-3-guest'
        ],
        { limit: 60, timeoutMs: 12_000 }
      )
      assertNoDecryptFailures(finalChannelRestore.messages, 'mixed channel restore round 3')

      const finalDmRestore = await syncUntilHealthy(
        finalOwnerSecondaryChat,
        dmScope,
        [
          'mix-dm-round-1-owner',
          'mix-dm-round-1-guest',
          'mix-dm-round-2-guest',
          'mix-dm-round-3-owner'
        ],
        { limit: 60, timeoutMs: 12_000 }
      )
      assertNoDecryptFailures(finalDmRestore.messages, 'mixed dm restore round 3')

      finalOwnerSecondaryChat.disconnect()
    } finally {
      ownerPrimaryChat.disconnect()
      ownerSecondaryChat.disconnect()
      guestPrimaryChat.disconnect()
    }
  })

  await t.test('cold archive backlog still decrypts after several hot-scope reconnect cycles', async () => {
    const base = Date.now()
    const ownerUsername = `sdk_temp_owner_${base}`
    const ownerPassword = 'vesper-sdk-temperature-owner-password'
    const guestUsername = `sdk_temp_guest_${base}`
    const guestPassword = 'vesper-sdk-temperature-guest-password'

    const ownerPrimary = createDeviceHarness(stack.apiUrl, 'temperature-owner-primary')
    const ownerSecondary = createDeviceHarness(stack.apiUrl, 'temperature-owner-secondary')
    const guestPrimary = createDeviceHarness(stack.apiUrl, 'temperature-guest-primary')

    const ownerPrimaryChat = createChatHarness(ownerPrimary)
    const ownerSecondaryChat = createChatHarness(ownerSecondary)
    const guestPrimaryChat = createChatHarness(guestPrimary)

    try {
      await ownerPrimary.register(ownerUsername, ownerPassword)
      await approveAndUnlockSecondary(
        ownerPrimary,
        ownerSecondary,
        ownerUsername,
        ownerPassword
      )

      await guestPrimary.register(guestUsername, guestPassword)

      const { channel: generalChannel, server } = await createGeneralChannel(
        ownerPrimary,
        `Chaos Temperature ${Date.now()}`
      )
      const archiveChannel = await ownerPrimary.createServerChannel(server.id, {
        name: 'archive'
      })
      const inviteCode = await ownerPrimary.getServerInviteCode(server.id)
      await guestPrimary.joinServerByInvite(inviteCode)

      const generalScope = { kind: 'channel', id: generalChannel.id }
      const archiveScope = { kind: 'channel', id: archiveChannel.id }

      await establishScope(ownerPrimaryChat, [ownerSecondaryChat, guestPrimaryChat], generalScope)
      await establishScope(ownerPrimaryChat, [ownerSecondaryChat, guestPrimaryChat], archiveScope)

      ownerSecondaryChat.disconnect()

      const archiveBurst = await sendBurst(
        [ownerPrimaryChat, guestPrimaryChat],
        archiveScope,
        'archive-cold',
        36
      )

      for (let round = 1; round <= 3; round += 1) {
        const resumedOwnerSecondaryChat = createChatHarness(ownerSecondary)
        await resumedOwnerSecondaryChat.watchScope(generalScope)

        await ownerPrimaryChat.sendText(generalScope, `general-hot-owner-${round}`)
        await guestPrimaryChat.sendText(generalScope, `general-hot-guest-${round}`)

        const generalRestore = await syncUntilHealthy(
          resumedOwnerSecondaryChat,
          generalScope,
          [`general-hot-owner-${round}`, `general-hot-guest-${round}`],
          { limit: 80, timeoutMs: 12_000 }
        )
        assertNoDecryptFailures(generalRestore.messages, `general hot restore round ${round}`)

        resumedOwnerSecondaryChat.disconnect()
      }

      const finalOwnerSecondaryChat = createChatHarness(ownerSecondary)
      await finalOwnerSecondaryChat.watchScope(generalScope)
      await finalOwnerSecondaryChat.watchScope(archiveScope)

      const finalArchiveRestore = await syncUntilHealthy(
        finalOwnerSecondaryChat,
        archiveScope,
        [archiveBurst[0], archiveBurst[18], archiveBurst[archiveBurst.length - 1]],
        { limit: 120, timeoutMs: 15_000 }
      )
      assertNoDecryptFailures(finalArchiveRestore.messages, 'cold archive restore')
      assertMessageTexts(finalArchiveRestore.messages, [
        archiveBurst[0],
        archiveBurst[18],
        archiveBurst[archiveBurst.length - 1]
      ])

      const finalGeneralRestore = await syncUntilHealthy(
        finalOwnerSecondaryChat,
        generalScope,
        ['general-hot-owner-3', 'general-hot-guest-3'],
        { limit: 80, timeoutMs: 12_000 }
      )
      assertNoDecryptFailures(finalGeneralRestore.messages, 'final general hot restore')

      finalOwnerSecondaryChat.disconnect()
    } finally {
      ownerPrimaryChat.disconnect()
      ownerSecondaryChat.disconnect()
      guestPrimaryChat.disconnect()
    }
  })

  await t.test('server join and leave churn preserves recoverability when a user rejoins with multiple devices', async () => {
    const base = Date.now()
    const ownerUsername = `sdk_churn_o_${base}`
    const ownerPassword = 'vesper-sdk-churn-owner-password'
    const guestUsername = `sdk_churn_g_${base}`
    const guestPassword = 'vesper-sdk-churn-guest-password'

    const ownerPrimary = createDeviceHarness(stack.apiUrl, 'churn-owner-primary')
    const guestPrimary = createDeviceHarness(stack.apiUrl, 'churn-guest-primary')
    const guestSecondary = createDeviceHarness(stack.apiUrl, 'churn-guest-secondary')

    const ownerPrimaryChat = createChatHarness(ownerPrimary)
    const guestPrimaryChat = createChatHarness(guestPrimary)
    const guestSecondaryChat = createChatHarness(guestSecondary)

    try {
      await ownerPrimary.register(ownerUsername, ownerPassword)
      await guestPrimary.register(guestUsername, guestPassword)
      await approveAndUnlockSecondary(
        guestPrimary,
        guestSecondary,
        guestUsername,
        guestPassword
      )

      const { channel, server } = await createGeneralChannel(
        ownerPrimary,
        `Chaos Churn ${Date.now()}`
      )
      const inviteCode = await ownerPrimary.getServerInviteCode(server.id)

      await guestPrimary.joinServerByInvite(inviteCode)
      await guestSecondary.joinServerByInvite(inviteCode)

      const scope = { kind: 'channel', id: channel.id }
      await establishScope(ownerPrimaryChat, [guestPrimaryChat, guestSecondaryChat], scope)

      await ownerPrimaryChat.sendText(scope, 'before-leave')
      const beforeLeave = await syncUntilMessages(
        guestSecondaryChat,
        scope,
        ['before-leave'],
        { limit: 20 }
      )
      assertNoDecryptFailures(beforeLeave.messages, 'pre-leave membership sync')

      guestSecondaryChat.disconnect()
      await guestPrimary.leaveServer(server.id)

      await waitForServerMembership(guestPrimary, server.id, false)
      await waitForServerMembership(guestSecondary, server.id, false)

      await ownerPrimaryChat.sendText(scope, 'while-away')

      await guestPrimary.joinServerByInvite(inviteCode)
      await guestSecondary.joinServerByInvite(inviteCode)

      await waitForServerMembership(guestPrimary, server.id, true)
      await waitForServerMembership(guestSecondary, server.id, true)
      await establishScope(ownerPrimaryChat, [guestPrimaryChat, guestSecondaryChat], scope)

      await ownerPrimaryChat.sendText(scope, 'after-rejoin')

      const guestPrimaryAfterRejoin = await syncUntilMessages(
        guestPrimaryChat,
        scope,
        ['after-rejoin'],
        { limit: 40 }
      )
      assertMessageDecrypts(
        guestPrimaryAfterRejoin.messages,
        'after-rejoin',
        'guest primary rejoin restore'
      )

      const resumedGuestSecondaryChat = createChatHarness(guestSecondary)
      const guestSecondaryAfterRejoin = await syncUntilMessages(
        resumedGuestSecondaryChat,
        scope,
        ['after-rejoin', 'before-leave'],
        { limit: 40 }
      )
      assertMessageDecrypts(
        guestSecondaryAfterRejoin.messages,
        'before-leave',
        'guest secondary rejoin restore'
      )
      assertMessageDecrypts(
        guestSecondaryAfterRejoin.messages,
        'after-rejoin',
        'guest secondary rejoin restore'
      )

      resumedGuestSecondaryChat.disconnect()
    } finally {
      ownerPrimaryChat.disconnect()
      guestPrimaryChat.disconnect()
      guestSecondaryChat.disconnect()
    }
  })

  await t.test('leaving a server tears down active channel listeners for removed devices', async () => {
    const base = Date.now()
    const ownerUsername = `sdk_leave_o_${base}`
    const ownerPassword = 'vesper-sdk-leave-owner-password'
    const guestUsername = `sdk_leave_g_${base}`
    const guestPassword = 'vesper-sdk-leave-guest-password'

    const ownerPrimary = createDeviceHarness(stack.apiUrl, 'leave-owner-primary')
    const guestPrimary = createDeviceHarness(stack.apiUrl, 'leave-guest-primary')
    const guestSecondary = createDeviceHarness(stack.apiUrl, 'leave-guest-secondary')

    const ownerPrimaryChat = createChatHarness(ownerPrimary)
    const guestPrimaryChat = createChatHarness(guestPrimary)
    const guestSecondaryChat = createChatHarness(guestSecondary)

    try {
      await ownerPrimary.register(ownerUsername, ownerPassword)
      await guestPrimary.register(guestUsername, guestPassword)
      await approveAndUnlockSecondary(
        guestPrimary,
        guestSecondary,
        guestUsername,
        guestPassword
      )

      const { channel, server } = await createGeneralChannel(
        ownerPrimary,
        `Chaos Leave ${Date.now()}`
      )
      const inviteCode = await ownerPrimary.getServerInviteCode(server.id)

      await guestPrimary.joinServerByInvite(inviteCode)
      await guestSecondary.joinServerByInvite(inviteCode)

      const scope = { kind: 'channel', id: channel.id }
      await establishScope(ownerPrimaryChat, [guestPrimaryChat, guestSecondaryChat], scope)

      await ownerPrimaryChat.sendText(scope, 'before-membership-revoke')
      const beforeLeave = await syncUntilMessages(
        guestSecondaryChat,
        scope,
        ['before-membership-revoke'],
        { limit: 20 }
      )
      assertNoDecryptFailures(beforeLeave.messages, 'pre-leave live sync')

      await guestPrimary.leaveServer(server.id)

      await waitForServerMembership(guestPrimary, server.id, false)
      await waitForServerMembership(guestSecondary, server.id, false)
      await assert.rejects(
        guestSecondary.fetchChannelMessages(channel.id, { limit: 5 }),
        /Could not load channel messages: 403/
      )

      await ownerPrimaryChat.sendText(scope, 'after-membership-revoke')
      await assertNoLiveMessage(
        guestSecondaryChat,
        scope.id,
        'after-membership-revoke'
      )
    } finally {
      ownerPrimaryChat.disconnect()
      guestPrimaryChat.disconnect()
      guestSecondaryChat.disconnect()
    }
  })

  await t.test('trusted device eviction sponsorship removes only the targeted leaf and carries the eviction id', async () => {
    const base = Date.now()
    const username = `sdk_eviction_${base}`
    const password = 'vesper-sdk-eviction-password'
    const primary = createDeviceHarness(stack.apiUrl, 'eviction-primary')
    const secondary = createDeviceHarness(stack.apiUrl, 'eviction-secondary')
    const primaryChat = createChatHarness(primary)
    const secondaryChat = createChatHarness(secondary)
    const capturedRemovals = []
    const scope = { kind: 'channel', id: null }

    const originalPush = primary.pushToTopicWithAck.bind(primary)
    primary.pushToTopicWithAck = async (topic, event, payload) => {
      if (event === 'mls_eviction_claim') {
        return true
      }

      if (event === 'mls_eviction_skip') {
        return true
      }

      if (event === 'mls_remove') {
        capturedRemovals.push({ topic, payload })
        await secondaryChat.handleScopeEvent(scope, 'mls_remove', {
          seq: Date.now(),
          removed_user_id: payload.removed_user_id,
          removed_device_id: payload.removed_device_id,
          commit_data: payload.commit_data,
          eviction_id: payload.eviction_id,
          sender_id: primary.requireSession().user.id,
          sender_device_id: primary.deviceIdentity.id
        })
        return true
      }

      return await originalPush(topic, event, payload)
    }

    try {
      await primary.register(username, password)
      await approveAndUnlockSecondary(primary, secondary, username, password)

      const { channel } = await createGeneralChannel(
        primary,
        `Chaos Eviction ${Date.now()}`
      )
      scope.id = channel.id
      await establishScope(primaryChat, [secondaryChat], scope)

      const evictionId = `eviction-${base}`
      await primaryChat.handleEvictionRequestEvent(scope, {
        eviction_id: evictionId,
        target_user_id: primary.requireSession().user.id,
        target_device_id: secondary.deviceIdentity.id
      })

      const removal = await waitFor(
        'mls_remove payload to be emitted for the eviction',
        async () =>
          capturedRemovals.find(
            (entry) =>
              entry.payload.eviction_id === evictionId &&
              entry.payload.commit_data &&
              entry.payload.removed_device_id === secondary.deviceIdentity.id
          ) ?? null,
        10_000,
        100
      )

      assert.equal(removal.payload.removed_user_id, primary.requireSession().user.id)
      assert.equal(removal.payload.removed_device_id, secondary.deviceIdentity.id)
      assert.equal(removal.payload.eviction_id, evictionId)

      await waitFor(
        'secondary device to lose MLS group state after eviction',
        async () => (secondaryChat.hasGroup(scope.id) ? null : true),
        10_000,
        100
      )
      assert.equal(primaryChat.hasGroup(scope.id), true)
    } finally {
      primaryChat.disconnect()
      secondaryChat.disconnect()
    }
  })
})
