import { VesperBot } from './bot-framework.mjs'

function formatHelp(botUserId) {
  return [
    `Mention <@${botUserId}> or use !commands in any channel the bot can read.`,
    'Commands:',
    'help',
    'ping',
    'echo <text>',
    'whoami'
  ].join('\n')
}

const bot = new VesperBot({
  deviceLabel: 'mention-command-bot'
})

bot.command('help', async ({ bot: runningBot, message }) => {
  await runningBot.reply(
    message.channelId,
    formatHelp(runningBot.user.id),
    {
      mentionUserId: message.senderId,
      parentMessageId: message.id
    }
  )
})

bot.command('ping', async ({ bot: runningBot, message }) => {
  await runningBot.reply(
    message.channelId,
    'pong',
    {
      mentionUserId: message.senderId,
      parentMessageId: message.id
    }
  )
})

bot.command('echo', async ({ bot: runningBot, command, message }) => {
  const reply = command.text || 'Nothing to echo.'
  await runningBot.reply(
    message.channelId,
    reply,
    {
      mentionUserId: message.senderId,
      parentMessageId: message.id
    }
  )
})

bot.command('whoami', async ({ bot: runningBot, message }) => {
  const label = runningBot.deviceIdentity?.name || 'SDK Sample bot'
  await runningBot.reply(
    message.channelId,
    `I am ${runningBot.user.username} on device "${label}".`,
    {
      mentionUserId: message.senderId,
      parentMessageId: message.id
    }
  )
})

bot.on('unknown-command', async ({ bot: runningBot, command, message }) => {
  await runningBot.reply(
    message.channelId,
    `Unknown command "${command.name}". Try help.`,
    {
      mentionUserId: message.senderId,
      parentMessageId: message.id
    }
  )
})

bot.on('command', async ({ source, message, command }) => {
  console.log(
    JSON.stringify(
      {
        action: 'command',
        source,
        channelId: message.channelId,
        messageId: message.id,
        senderId: message.senderId,
        senderUsername: message.senderUsername,
        command: command.name,
        args: command.args
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
      device: bot.deviceIdentity,
      usage: [
        `Mention <@${bot.user.id}> ping`,
        `Mention <@${bot.user.id}> echo hello`,
        '!ping',
        '!help'
      ]
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
