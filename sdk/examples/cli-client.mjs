import { homedir } from 'node:os'
import path from 'node:path'

import {
  VesperStorage,
  createFileSessionStore,
  createVesperClient
} from '../dist/index.js'

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}

function slugify(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return normalized || 'sample'
}

function resolveSampleStateDir(deviceLabel) {
  return path.join(homedir(), '.vesper-sdk-samples', slugify(deviceLabel))
}

function usage() {
  console.error(`Usage:
  node sdk/examples/cli-client.mjs me
  node sdk/examples/cli-client.mjs servers
  node sdk/examples/cli-client.mjs conversations
  node sdk/examples/cli-client.mjs search-user <username>
  node sdk/examples/cli-client.mjs create-conversation <username> [name]
  node sdk/examples/cli-client.mjs devices
  node sdk/examples/cli-client.mjs approve-pending
  node sdk/examples/cli-client.mjs watch

Required environment:
  VESPER_API_URL
  VESPER_USERNAME
  VESPER_PASSWORD`)
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2))
}

async function ensureSession() {
  const baseUrl = requiredEnv('VESPER_API_URL')
  const baseDir = resolveSampleStateDir('cli')
  const client = createVesperClient({
    baseUrl,
    sessionStore: createFileSessionStore(path.join(baseDir, 'session.json'), baseUrl),
    storage: (userId) =>
      new VesperStorage.FileCryptoStorage(path.join(baseDir, 'crypto', `${userId}.json`))
  })
  const username = requiredEnv('VESPER_USERNAME')
  const password = requiredEnv('VESPER_PASSWORD')

  const session = (await client.restoreSession()) ?? (await client.login(username, password))
  await client.start(false)

  return { client, session }
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
  const { client } = await ensureSession()
  printJson(client.getState().servers)
}

async function commandConversations() {
  const { client } = await ensureSession()
  printJson(client.getState().conversations)
}

async function commandSearchUser(username) {
  if (!username) {
    throw new Error('search-user requires a username')
  }

  const { client } = await ensureSession()
  printJson(await client.searchUsers(username))
}

async function commandCreateConversation(username, name) {
  if (!username) {
    throw new Error('create-conversation requires a username')
  }

  const { client } = await ensureSession()
  const users = await client.searchUsers(username)
  const user = users[0]
  if (!user) {
    throw new Error(`User not found: ${username}`)
  }

  const conversation = await client.createConversation([user.id], name)
  printJson(conversation)
}

async function commandDevices() {
  const { client } = await ensureSession()
  const state = await client.fetchDevices()
  printJson({
    devices: state.devices,
    currentDevice: state.currentDevice,
    canUseE2EE: state.canUseE2EE
  })
}

async function commandApprovePending() {
  const { client } = await ensureSession()
  const state = await client.fetchDevices()
  const pending = state.devices.filter((device) => device.trust_state === 'pending')
  for (const device of pending) {
    await client.approveDevice(device.id)
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
  const { client, session } = await ensureSession()
  const stopRaw = client.on('raw', ({ event, payload }) => {
    printJson({
      topic: `user:${session.user.id}`,
      event,
      payload
    })
  })

  console.error(`Watching user:${session.user.id}`)

  const shutdown = () => {
    stopRaw()
    client.stop()
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
