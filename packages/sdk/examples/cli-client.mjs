import {
  createConversation,
  createSdkHarness,
  getCurrentUser,
  listConversations,
  listServers,
  registerOrLogin,
  requiredEnv,
  searchUsers
} from './_shared.mjs'

function usage() {
  console.error(`Usage:
  node packages/sdk/examples/cli-client.mjs me
  node packages/sdk/examples/cli-client.mjs servers
  node packages/sdk/examples/cli-client.mjs conversations
  node packages/sdk/examples/cli-client.mjs search-user <username>
  node packages/sdk/examples/cli-client.mjs create-conversation <username> [name]
  node packages/sdk/examples/cli-client.mjs devices
  node packages/sdk/examples/cli-client.mjs approve-pending
  node packages/sdk/examples/cli-client.mjs watch

Required environment:
  VESPER_API_URL
  VESPER_USERNAME
  VESPER_PASSWORD`)
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2))
}

async function ensureSession() {
  const username = requiredEnv('VESPER_USERNAME')
  const password = requiredEnv('VESPER_PASSWORD')
  const harness = createSdkHarness('cli')
  const session = await registerOrLogin(harness.auth, username, password)

  return {
    ...harness,
    session
  }
}

async function commandMe() {
  const { session } = await ensureSession()
  printJson({
    user: session.user,
    currentDevice: session.currentDevice,
    canUseE2EE: session.canUseE2EE
  })
}

async function commandServers() {
  await ensureSession()
  printJson(await listServers())
}

async function commandConversations() {
  await ensureSession()
  printJson(await listConversations())
}

async function commandSearchUser(username) {
  if (!username) {
    throw new Error('search-user requires a username')
  }

  await ensureSession()
  printJson(await searchUsers(username))
}

async function commandCreateConversation(username, name) {
  if (!username) {
    throw new Error('create-conversation requires a username')
  }

  await ensureSession()
  const users = await searchUsers(username)
  const user = users[0]
  if (!user) {
    throw new Error(`User not found: ${username}`)
  }

  const conversation = await createConversation([user.id], name)
  printJson(conversation)
}

async function commandDevices() {
  const { auth, session } = await ensureSession()
  const devices = await auth.fetchDevices({
    devices: session.devices,
    currentDevice: session.currentDevice,
    user: session.user
  })
  printJson(devices)
}

async function commandApprovePending() {
  const { auth, session } = await ensureSession()
  const devices = await auth.fetchDevices({
    devices: session.devices,
    currentDevice: session.currentDevice,
    user: session.user
  })

  const pending = devices.devices.filter((device) => device.trust_state === 'pending')
  for (const device of pending) {
    await auth.approveDevice(device.id)
  }

  printJson({
    approved: pending.map((device) => ({
      id: device.id,
      client_id: device.client_id,
      name: device.name
    }))
  })
}

async function commandWatch() {
  const { session, socket } = await ensureSession()
  const topic = `user:${session.user.id}`

  socket.connect()
  await socket.joinChannelWithAck(topic, (event, payload) => {
    printJson({
      topic,
      event,
      payload
    })
  })

  socket.pushToChannel(topic, 'heartbeat', {})
  console.error(`Watching ${topic}`)

  const heartbeat = setInterval(() => {
    socket.pushToChannel(topic, 'heartbeat', {})
  }, 60_000)

  const shutdown = () => {
    clearInterval(heartbeat)
    socket.disconnect()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await new Promise(() => {})
}

async function main() {
  const [command, ...args] = process.argv.slice(2)

  switch (command) {
    case 'me':
      await commandMe()
      return
    case 'servers':
      await commandServers()
      return
    case 'conversations':
      await commandConversations()
      return
    case 'search-user':
      await commandSearchUser(args[0])
      return
    case 'create-conversation':
      await commandCreateConversation(args[0], args[1])
      return
    case 'devices':
      await commandDevices()
      return
    case 'approve-pending':
      await commandApprovePending()
      return
    case 'watch':
      await commandWatch()
      return
    default:
      usage()
      process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
