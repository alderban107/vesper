# OpenTUI Vesper Chat Client

This sample is a real terminal chat client built on the Vesper SDK and `@opentui/core`.

It includes:

- a server URL field on the auth screen
- login, register, and recovery flows
- a recovery-key handoff after signup
- current-device approval before encrypted chat unlocks
- servers, channels, direct messages, live transcript updates, and a composer
- slash commands for common SDK actions

## Requirements

- Bun
- a built SDK package

Build the SDK first:

```bash
npm run build -w @vesper/sdk
```

Install the OpenTUI sample dependencies:

```bash
cd packages/sdk/examples/opentui
bun install
```

Run the client:

```bash
bun run client.mjs
```

You can also prefill fields with environment variables:

```bash
VESPER_API_URL=http://127.0.0.1:4000 \
VESPER_USERNAME=alice \
VESPER_PASSWORD=super-secret-password \
VESPER_DEVICE_ID=sample-alice-opentui \
bun run client.mjs
```

## Chat commands

Type these into the composer:

- `/help`
- `/refresh`
- `/dm <username>`
- `/join <invite-code>`
- `/logout`
- `/quit`

## Notes

- The sample still treats the app as the SDK consumer. The server URL is set in the client UI and then passed into the SDK runtime.
- The sample imports the built SDK from `packages/sdk/dist`, so rebuild the SDK after SDK changes.
- OpenTUI currently targets Bun in practice, so syntax checks here use `node --check`, but the sample itself should be run with Bun.
