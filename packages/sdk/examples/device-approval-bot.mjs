import { VesperBot } from './bot-framework.mjs'

const allowAll = process.env.VESPER_APPROVE_ALL === '1'
const allowedPrefix = process.env.VESPER_APPROVE_DEVICE_PREFIX?.trim() || ''

function shouldApprove(device) {
  if (allowAll) {
    return true
  }

  if (allowedPrefix) {
    return device.name.startsWith(allowedPrefix)
  }

  return false
}

const bot = new VesperBot({
  deviceLabel: 'device-approval-bot'
})

bot.on('device_approval_requested', async ({ bot: runningBot, payload }) => {
  const device = payload.device
  if (!device) {
    return
  }

  if (!shouldApprove(device)) {
    console.log(
      JSON.stringify(
        {
          action: 'ignored',
          reason: 'device did not match approval policy',
          device
        },
        null,
        2
      )
    )
    return
  }

  await runningBot.approveDevice(device.id)
  console.log(
    JSON.stringify(
      {
        action: 'approved',
        device: {
          id: device.id,
          client_id: device.client_id,
          name: device.name
        }
      },
      null,
      2
    )
  )
})

bot.on('*', async ({ event, payload }) => {
  if (event === 'device_approval_requested') {
    return
  }

  console.log(
    JSON.stringify(
      {
        action: 'event',
        event,
        payload
      },
      null,
      2
    )
  )
})

await bot.start()

console.log(
  JSON.stringify(
    {
      status: 'running',
      user: bot.user,
      allowAll,
      allowedPrefix: allowedPrefix || null
    },
    null,
    2
  )
)

const shutdown = async () => {
  await bot.stop()
  process.exit(0)
}

process.on('SIGINT', () => {
  void shutdown()
})
process.on('SIGTERM', () => {
  void shutdown()
})

await new Promise(() => {})
