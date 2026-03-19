import assert from 'node:assert/strict'
import test from 'node:test'

import { getMyKeyPackageCount } from '../dist/api/index.js'
import { VesperAuthClient } from '../dist/auth/index.js'
import { MemoryStorage } from '../dist/storage/index.js'
import { bootServerStack, teardownServerStack } from '../dist/testing/index.js'
import {
  createMemorySessionStore,
  createVesperTransport
} from '../dist/transport/index.js'

function createHarness(apiUrl, label) {
  const device = {
    id: `sdk-${label}-${Math.random().toString(36).slice(2, 10)}`,
    name: `SDK ${label}`,
    platform: 'node'
  }
  const sessionStore = createMemorySessionStore(apiUrl)
  const storage = new MemoryStorage()
  const transport = createVesperTransport({
    baseUrl: apiUrl,
    fetchImpl: fetch,
    sessionStore,
    socketOptions: {
      logger: {
        error: () => {},
        log: () => {}
      }
    }
  })

  return {
    auth: new VesperAuthClient({
      getDeviceIdentity: () => device,
      storage,
      transport
    }),
    device,
    httpClient: transport.httpClient,
    sessionStore,
    socketClient: transport.socketClient,
    storage
  }
}

async function runWithHarness(harness, operation) {
  return await operation(harness.auth)
}

test('sdk auth client registers, restores session, and uploads key packages', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const harness = createHarness(stack.apiUrl, 'primary')
  const username = `sdk_auth_${Date.now()}`
  const password = 'vesper-sdk-auth-password'

  const registered = await runWithHarness(harness, (auth) => auth.register(username, password))
  assert.equal(registered.user.username, username)
  assert.equal(registered.canUseE2EE, true)
  assert.match(registered.recoveryMnemonic ?? '', /\S+\s+\S+/)

  const packageCount = await runWithHarness(harness, () =>
    getMyKeyPackageCount(harness.device.id, harness.httpClient)
  )
  assert.equal(packageCount, 20)

  await runWithHarness(harness, (auth) => auth.logout())

  const relogged = await runWithHarness(harness, (auth) => auth.login(username, password))
  assert.equal(relogged.user.id, registered.user.id)
  assert.equal(relogged.canUseE2EE, true)

  const restored = await runWithHarness(harness, (auth) => auth.checkAuth())
  assert.ok(restored)
  assert.equal(restored?.user.id, registered.user.id)
})

test('sdk auth client verifies recovery keys and resets credentials on a new device', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const primaryHarness = createHarness(stack.apiUrl, 'primary-recovery')
  const username = `sdk_recovery_${Date.now()}`
  const originalPassword = 'vesper-sdk-original-password'
  const nextPassword = 'vesper-sdk-next-password'

  const registered = await runWithHarness(primaryHarness, (auth) =>
    auth.register(username, originalPassword)
  )
  const mnemonic = registered.recoveryMnemonic
  assert.ok(mnemonic)

  const recoveredHarness = createHarness(stack.apiUrl, 'recovered')
  await runWithHarness(recoveredHarness, (auth) => auth.verifyRecoveryKey(mnemonic))

  const recovered = await runWithHarness(recoveredHarness, (auth) =>
    auth.recoverAccount(mnemonic, nextPassword)
  )
  assert.equal(recovered.user.id, registered.user.id)
  assert.equal(recovered.canUseE2EE, true)

  await runWithHarness(recoveredHarness, (auth) => auth.logout())

  const relogged = await runWithHarness(recoveredHarness, (auth) =>
    auth.login(username, nextPassword)
  )
  assert.equal(relogged.user.id, registered.user.id)

  const staleHarness = createHarness(stack.apiUrl, 'stale-password')
  await assert.rejects(
    async () => {
      await runWithHarness(staleHarness, (auth) => auth.login(username, originalPassword))
    },
    /login failed|invalid/i
  )
})

test('sdk auth client supports multi-device approval and trusted-device unlock', { concurrency: false }, async (t) => {
  const stack = await bootServerStack()
  t.after(async () => {
    await teardownServerStack(stack)
  })

  const primaryHarness = createHarness(stack.apiUrl, 'primary-device')
  const secondaryHarness = createHarness(stack.apiUrl, 'secondary-device')
  const username = `sdk_device_${Date.now()}`
  const password = 'vesper-sdk-device-password'

  const primarySession = await runWithHarness(primaryHarness, (auth) =>
    auth.register(username, password)
  )
  const secondarySession = await runWithHarness(secondaryHarness, (auth) =>
    auth.login(username, password)
  )

  assert.equal(secondarySession.currentDevice?.trust_state, 'pending')
  assert.equal(secondarySession.canUseE2EE, false)

  const pendingState = await runWithHarness(primaryHarness, (auth) =>
    auth.fetchDevices({
      devices: primarySession.devices,
      currentDevice: primarySession.currentDevice,
      user: primarySession.user
    })
  )
  const pendingDevice = pendingState.devices.find(
    (device) => device.client_id === secondaryHarness.device.id
  )
  assert.ok(pendingDevice)
  assert.equal(pendingDevice?.trust_state, 'pending')

  await runWithHarness(primaryHarness, (auth) => auth.approveDevice(pendingDevice.id))

  const trustedState = await runWithHarness(primaryHarness, (auth) =>
    auth.fetchDevices({
      devices: pendingState.devices,
      currentDevice: pendingState.currentDevice,
      user: primarySession.user
    })
  )
  const trustedDevice = trustedState.devices.find(
    (device) => device.client_id === secondaryHarness.device.id
  )
  assert.ok(trustedDevice)
  assert.equal(trustedDevice?.trust_state, 'trusted')

  const secondaryDeviceState = await runWithHarness(secondaryHarness, (auth) =>
    auth.fetchDevices({
      devices: secondarySession.devices,
      currentDevice: secondarySession.currentDevice,
      user: secondarySession.user
    })
  )
  assert.equal(secondaryDeviceState.currentDevice?.trust_state, 'trusted')
  assert.equal(secondaryDeviceState.canUseE2EE, false)

  const unlocked = await runWithHarness(secondaryHarness, (auth) =>
    auth.unlockTrustedDevice(
      secondarySession.user,
      secondaryDeviceState.currentDevice,
      password
    )
  )
  assert.equal(unlocked.currentDevice?.trust_state, 'trusted')
  assert.equal(unlocked.canUseE2EE, true)
})
