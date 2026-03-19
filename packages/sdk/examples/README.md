# Vesper SDK Samples

Start with [../README.md](../README.md) for the shortest setup.

These examples use the built SDK from `packages/sdk/dist`.

They show the current contract clearly:

- the SDK consumer provides the server URL
- Node consumers provide a storage adapter
- sample apps provide their own device identity
- auth, recovery, and realtime flows go through the SDK

Build the SDK first:

```bash
npm run build -w @vesper/sdk
```

## CLI client

The CLI client is a simple headless consumer that can authenticate, inspect state, watch the user feed, and approve pending devices.

```bash
VESPER_API_URL=http://127.0.0.1:4000 \
VESPER_USERNAME=alice \
VESPER_PASSWORD=super-secret-password \
node packages/sdk/examples/cli-client.mjs me
```

Useful commands:

```bash
node packages/sdk/examples/cli-client.mjs servers
node packages/sdk/examples/cli-client.mjs conversations
node packages/sdk/examples/cli-client.mjs search-user bob
node packages/sdk/examples/cli-client.mjs create-conversation bob
node packages/sdk/examples/cli-client.mjs devices
node packages/sdk/examples/cli-client.mjs approve-pending
node packages/sdk/examples/cli-client.mjs watch
```

Set `VESPER_DEVICE_ID` if you want to pin a sample to a specific device id across runs. If you leave it unset, the samples derive a stable id from the username and sample name.

## Channel bot framework

`bot-framework.mjs` wraps auth, user-topic subscriptions, channel joins, MLS group setup, encrypted channel sends, mention handling, and command dispatch for headless bots.

The included sample bot replies in-channel when mentioned and also handles `!` commands after it has joined a channel:

```bash
VESPER_API_URL=http://127.0.0.1:4000 \
VESPER_USERNAME=alice \
VESPER_PASSWORD=super-secret-password \
VESPER_DEVICE_ID=sample-alice-mention-bot \
node packages/sdk/examples/mention-command-bot.mjs
```

Try messages like:

```bash
<@BOT_USER_ID> help
<@BOT_USER_ID> ping
<@BOT_USER_ID> echo hello from the sdk
!help
!ping
```

## OpenTUI chat client

`examples/opentui/client.mjs` is a full terminal chat client rather than a status dashboard. It includes a server URL field, login/register/recovery screens, device approval, server and DM navigation, live transcript updates, and a composer that sends through the SDK runtime.

```bash
npm run build -w @vesper/sdk
cd packages/sdk/examples/opentui
bun install
bun run client.mjs
```

You can prefill the form with environment variables if you want:

```bash
VESPER_API_URL=http://127.0.0.1:4000 \
VESPER_USERNAME=alice \
VESPER_PASSWORD=super-secret-password \
bun run client.mjs
```

## Smaller focused samples

Auth/register-or-login:

```bash
VESPER_API_URL=http://127.0.0.1:4000 \
VESPER_USERNAME=alice \
VESPER_PASSWORD=super-secret-password \
node packages/sdk/examples/node-auth.mjs
```

Recovery flow:

```bash
VESPER_API_URL=http://127.0.0.1:4000 \
VESPER_RECOVERY_KEY="word1 word2 ..." \
VESPER_NEW_PASSWORD=new-password \
node packages/sdk/examples/node-recovery.mjs
```

Realtime smoke:

```bash
VESPER_API_URL=http://127.0.0.1:4000 \
VESPER_USERNAME=alice \
VESPER_PASSWORD=super-secret-password \
node packages/sdk/examples/node-realtime.mjs
```

If the account does not exist yet, the auth and realtime samples will register it first.
