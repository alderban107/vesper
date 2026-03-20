# Bots

The SDK ships with a bot framework in the examples directory (`packages/sdk/examples/bot-framework.mjs`). It handles authentication, MLS group management, event routing, and command dispatch so you can focus on bot logic.

## Quick Example

```javascript
import { VesperBot } from './bot-framework.mjs'

const bot = new VesperBot()
await bot.start()

bot.command('ping', async (ctx) => {
  await ctx.reply('pong')
})

bot.command('echo', async (ctx) => {
  await ctx.reply(ctx.args.join(' '))
})
```

## Setup

Bots use the same SDK primitives as any client. Configure through environment variables:

| Variable | Description |
|----------|-------------|
| `VESPER_API_URL` | Server URL (default: `http://127.0.0.1:4000`) |
| `VESPER_USERNAME` | Bot account username |
| `VESPER_PASSWORD` | Bot account password |

The bot framework handles:
- Session persistence across restarts
- Automatic MLS group joins and key package replenishment
- Message deduplication (tracks recent 256 message IDs)
- Join request cooldowns (1.5s debounce)

## Command Dispatch

Commands can be triggered by mentions or by a prefix.

### Mention-Based Commands

When another user sends a message mentioning the bot:

```
@bot-username help
@bot-username echo hello world
```

The bot extracts the command name and arguments from the text after the mention.

### Prefix-Based Commands

Configure a prefix (e.g., `!`) and the bot will respond to:

```
!help
!ping
!echo hello world
```

### Registering Commands

```javascript
bot.command('help', async (ctx) => {
  const commandList = bot.getCommands()
    .map(c => `  ${c}`)
    .join('\n')
  await ctx.reply(`Available commands:\n${commandList}`)
})

bot.command('whoami', async (ctx) => {
  await ctx.reply(`You are ${ctx.senderUsername} (${ctx.senderId})`)
})
```

### Command Context

The handler receives a context object:

```javascript
bot.command('greet', async (ctx) => {
  ctx.channelId        // Channel where the command was sent
  ctx.senderId         // User ID of the sender
  ctx.senderUsername   // Username of the sender
  ctx.args             // Array of arguments after the command name
  ctx.message          // Full message object

  await ctx.reply('Hello!')  // Reply in the same channel
})
```

## Event Handling

Subscribe to raw events:

```javascript
// All events
bot.on('*', (event) => {
  console.log('Event:', event.type, event)
})

// Specific events
bot.on('mention', (event) => {
  console.log('Mentioned by:', event.senderUsername)
})

bot.on('message', (event) => {
  // Every decrypted message, not just commands
})

bot.on('device_approval_requested', (event) => {
  // A new device wants to be trusted
})

bot.on('command', (event) => {
  // A recognized command was invoked
})

bot.on('unknown-command', (event) => {
  // An unrecognized command was attempted
})
```

## Sending Messages

```javascript
// Send to a channel
await bot.sendChannelText(channelId, 'Hello, channel!')

// Reply with a mention
await bot.reply(channelId, `Got your message`, {
  mentionUserId: senderId,
  parentMessageId: messageId,  // Thread reply
})
```

## MLS Group Management

The bot framework handles MLS automatically:

1. On startup, it joins the user topic to receive events
2. When a `mls_request_join` event arrives, it processes the join request (adds the requester's key package, creates a commit)
3. When a `mls_welcome` event arrives, it processes the welcome to join existing groups
4. When a `mls_commit` event arrives, it applies the commit to update group state
5. It encrypts outgoing messages and decrypts incoming ones transparently

Key package replenishment happens automatically when the pool runs low.

## Device Approval Bot

A specialized bot that auto-approves pending devices:

```javascript
import { VesperBot } from './bot-framework.mjs'

const bot = new VesperBot()
await bot.start()

bot.on('device_approval_requested', async (event) => {
  const { device_id, device_name } = event

  // Approve all devices
  await bot.approveDevice(device_id)
  console.log(`Approved device: ${device_name}`)

  // Or filter by name prefix
  if (device_name.startsWith('trusted-')) {
    await bot.approveDevice(device_id)
  }
})
```

## Lifecycle

```javascript
const bot = new VesperBot()

// Start: authenticate, connect socket, sync workspace
await bot.start()

// Graceful shutdown
process.on('SIGINT', () => {
  bot.stop()
  process.exit(0)
})
```

## Running the Examples

Build the SDK first, then run:

```bash
npm run build -w @vesper/sdk

# CLI client
npm run sample:cli -w @vesper/sdk -- me
npm run sample:cli -w @vesper/sdk -- servers
npm run sample:cli -w @vesper/sdk -- watch

# Mention-command bot
npm run sample:bot:mention -w @vesper/sdk

# Auth flow
npm run sample:auth -w @vesper/sdk

# Recovery flow
npm run sample:recovery -w @vesper/sdk

# Real-time socket events
npm run sample:realtime -w @vesper/sdk
```

Set environment variables before running:

```bash
export VESPER_API_URL=http://127.0.0.1:4000
export VESPER_USERNAME=mybot
export VESPER_PASSWORD=bot-password
```
