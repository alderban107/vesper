# Vesper E2E Smoke Requirements

This file is the source of truth for the Playwright harness under `client/e2e/`.

It exists for one reason: before we move real people onto Vesper, we need a
test system that proves the product feels smooth in the ordinary Discord-like
path people live in every day. Create a place. Make channels. Join it. Chat in
real time. React. Share files. Refresh. Come back later. It should still work.

The harness must catch broken chat behavior, broken sync, broken encryption
recovery, and the smaller UI-state failures that make a chat app feel flaky
even when the backend is technically up.

Every future E2E helper, spec, fixture, and CI job should point back to the
requirement IDs in this file.

Related docs:

- `doc/e2ee/REQUIREMENTS-E2EE.md`
- `doc/e2ee/E2EE-IMPLEMENTATION.md`
- `doc/MATRIX-CORE-ANALYSIS.md`

## Product Surfaces This Document Covers

These code paths are the current behavioral surface area the smoke harness needs
to protect:

- `client/src/renderer/src/stores/messageStore.ts`
- `client/src/renderer/src/stores/serverStore.ts`
- `client/src/renderer/src/stores/dmStore.ts`
- `client/src/renderer/src/stores/unreadStore.ts`
- `client/src/renderer/src/stores/authStore.ts`
- `client/src/renderer/src/stores/cryptoStore.ts`
- `client/src/renderer/src/stores/voiceStore.ts`
- `client/src/renderer/src/api/socket.ts`
- `client/src/renderer/src/pages/MainPage.tsx`
- `client/src/renderer/src/components/chat/MessageInput.tsx`
- `client/src/renderer/src/components/dm/DmMessageInput.tsx`
- `client/src/renderer/src/components/chat/MessageItem.tsx`
- `client/src/renderer/src/components/chat/message/MessageFeed.tsx`
- `client/src/renderer/src/components/chat/PinnedMessagesPopover.tsx`
- `client/src/renderer/src/components/chat/SearchBar.tsx`
- `client/src/renderer/src/components/chat/DisappearingSettings.tsx`
- `client/src/renderer/src/components/auth/DeviceTrustGate.tsx`
- `client/src/renderer/src/components/server/ServerSettingsModal.tsx`
- `client/src/renderer/src/components/server/InviteManager.tsx`
- `server/lib/vesper_web/channels/chat_channel.ex`
- `server/lib/vesper_web/channels/dm_channel.ex`
- `server/lib/vesper_web/channels/voice_channel.ex`
- `server/lib/vesper_web/controllers/message_controller.ex`
- `server/lib/vesper_web/controllers/conversation_controller.ex`
- `server/lib/vesper_web/controllers/server_controller.ex`
- `server/lib/vesper_web/controllers/emoji_controller.ex`
- `server/lib/vesper_web/controllers/pending_welcome_controller.ex`
- `server/lib/vesper_web/controllers/pending_resync_request_controller.ex`

## Test Philosophy

This harness is not allowed to hand-wave.

It must use:

- a real local backend
- a real web client
- real browser clients
- real websocket joins
- real IndexedDB and localStorage
- real encrypted message flows
- real reloads and reconnects

It must not use:

- mocked chat state
- fake transport
- fake crypto
- test-only plaintext bypasses
- assertions that only check for "something on screen"

The suite must prove state convergence across clients, not just isolated actions
 on one page.

## Priority Levels

- `P0`: ship-blocking smoke coverage; this must pass before we trust a build.
- `P1`: strong behavioral coverage that should land immediately after the first
  harness.
- `P2`: wider reliability and admin coverage once the core path is stable.

## Requirement Index

| ID | Priority | Summary |
|----|----------|---------|
| R-HARNESS-1 | P0 | Every run boots a fresh local stack on unique temp ports |
| R-HARNESS-2 | P0 | Runtime state is isolated per run |
| R-HARNESS-3 | P0 | Failures preserve useful artifacts |
| R-HARNESS-4 | P0 | Readiness checks replace blind sleeps |
| R-HARNESS-5 | P0 | Browser clients use persistent profiles inside a run |
| R-HARNESS-6 | P1 | Key UI surfaces expose stable selectors for E2E |
| R-HARNESS-7 | P1 | Voice and video scenarios use deterministic fake media devices |
| R-AUTH-1 | P0 | Three users can sign up from clean clients |
| R-AUTH-2 | P0 | Login lands users in a usable encrypted state |
| R-AUTH-3 | P1 | Recovery key and device trust gating are covered |
| R-AUTH-4 | P1 | Session-renewal failure returns the client to a sane sign-in path |
| R-NAV-1 | P0 | Server, channel, and DM selection survive refresh |
| R-NAV-2 | P1 | Thread context survives refresh or is restored clearly |
| R-DM-1 | P0 | Two users can create and use an encrypted DM |
| R-DM-2 | P0 | DM history survives refresh and browser restart |
| R-DM-3 | P0 | DM reactions and threaded replies converge |
| R-DM-4 | P1 | DM typing and unread state behave correctly |
| R-DM-5 | P1 | DM attachments decrypt and render correctly |
| R-SERVER-1 | P0 | An admin can create a server and channels |
| R-SERVER-2 | P0 | Users can join the server through supported invite flows |
| R-SERVER-3 | P0 | Server membership and channel visibility converge |
| R-SERVER-4 | P1 | Member list and presence update live |
| R-SERVER-5 | P2 | Permission overrides are enforced across clients |
| R-SERVER-6 | P2 | Channel categories and ordering converge across clients |
| R-CHANNEL-1 | P0 | Three users can chat in channels |
| R-CHANNEL-2 | P0 | Channel threads stay threaded and off the main timeline |
| R-CHANNEL-3 | P1 | Unread badges and read clearing behave correctly |
| R-CHANNEL-4 | P1 | Typing indicators behave correctly |
| R-CHANNEL-5 | P1 | Message edit and delete actions converge |
| R-CHANNEL-6 | P1 | Pin, unpin, and jump-to-message work after refresh |
| R-CHANNEL-7 | P1 | Disappearing message TTL changes and expiry converge |
| R-EMOJI-1 | P0 | Custom emoji upload and use work across clients |
| R-EMOJI-2 | P1 | Custom emoji work in both message bodies and reactions |
| R-MSG-1 | P1 | Channel and DM attachments work end to end |
| R-MSG-2 | P1 | Image and audio previews decrypt correctly |
| R-MSG-3 | P1 | Search can find past messages and jump to them |
| R-MSG-4 | P1 | Mentions behave correctly |
| R-SYNC-1 | P0 | Reload and reconnect do not leave clients behind |
| R-SYNC-2 | P0 | Missing live updates are recovered without manual repair in the happy path |
| R-SYNC-3 | P0 | Broken local crypto state has a supported repair path |
| R-SYNC-4 | P1 | A client coming back after offline activity catches up cleanly |
| R-SYNC-5 | P1 | Pending welcomes and resync requests are exercised for real |
| R-E2EE-1 | P0 | No user-visible decryption failure is acceptable in the happy path |
| R-E2EE-2 | P0 | Recovery flows stay end-to-end encrypted |
| R-E2EE-3 | P1 | Trusted-but-locked device unlock is covered |
| R-E2EE-4 | P1 | Pending device approval with recovery key is covered |
| R-VOICE-1 | P1 | Encrypted DM call setup and teardown work |
| R-VOICE-2 | P1 | Encrypted channel voice join and reconnect work |
| R-VOICE-3 | P1 | Camera publish and remote video rendering work |
| R-VOICE-4 | P2 | Screen share and share-audio behavior work |
| R-VOICE-5 | P2 | Voice and video device failure paths degrade cleanly |
| R-ASSERT-1 | P0 | Assertions compare exact cross-client state |
| R-ASSERT-2 | P0 | The suite fails on duplicates, gaps, and stale counters |
| R-ASSERT-3 | P0 | Known console and network failure signatures fail the run |
| R-ASSERT-4 | P1 | The harness records normalized snapshots at key checkpoints |
| R-ASSERT-5 | P1 | The first run proves enough to gate pre-merge CI |

## Harness Requirements

### R-HARNESS-1: Every run boots a fresh local stack on unique temp ports

The harness must start the stack itself. A developer must not need to start
Phoenix or Vite by hand before running E2E.

Minimum shape:

- Phoenix API on a temp port
- web client on a temp port
- runtime API URL injected into the web client for the run

Hard rules:

- no shared fixed ports
- no reuse of an already running local stack
- no dependence on the tester already being signed in

### R-HARNESS-2: Runtime state is isolated per run

A run must not inherit chat state from an earlier run.

Fresh per run:

- database or database namespace
- uploads directory
- browser profile directories
- Playwright output directory
- backend and frontend logs

If disposable containers are not available, the harness must create and drop a
unique local database for the run.

### R-HARNESS-3: Failures preserve useful artifacts

When a run fails, it must preserve:

- backend logs
- frontend logs
- Playwright trace
- screenshots
- per-client console logs
- websocket and HTTP failures tied to the scenario

Artifacts must be grouped by run and by client so a broken step can be traced
without rerunning.

### R-HARNESS-4: Readiness checks replace blind sleeps

The harness must wait on real readiness signals for:

- backend health
- web app availability
- authenticated app shell availability
- socket-connected state where needed
- post-reload sync completion before assertions

Small polling backoffs inside helpers are fine. Long fixed sleeps are not.

### R-HARNESS-5: Browser clients use persistent profiles inside a run

Each browser client must keep its own persistent profile directory for the
duration of the run so refreshes and browser restarts preserve:

- IndexedDB
- localStorage
- session storage
- device identity
- local crypto state

The suite should treat `alice`, `bob`, and `charlie` as three real people, not
three tabs sharing the same storage.

### R-HARNESS-6: Key UI surfaces expose stable selectors for E2E

The harness should not depend on brittle CSS copy where a better selector can
exist.

P1 work should add stable selectors for at least:

- server list and server rows
- channel rows
- DM rows
- message rows
- thread panel
- reaction buttons
- pin popover
- invite creation controls
- emoji upload controls
- device trust gate
- voice room controls
- camera and screen-share controls

### R-HARNESS-7: Voice and video scenarios use deterministic fake media devices

The web E2E harness must cover voice and video on the actual browser client, so
it needs deterministic fake media instead of hoping a developer machine has a
usable webcam and mic attached.

The harness should launch Chromium with media-test flags such as:

- `--test-type`
- `--use-fake-ui-for-media-stream`
- `--use-fake-device-for-media-stream`
- `--use-file-for-fake-video-capture=/abs/path/to/test-video.y4m`

And it should provide deterministic test media where possible:

- a fake microphone source for repeatable audio capture
- a fake camera feed for repeatable video publish
- a predictable screen-share source, or the closest reliable browser-controlled
  equivalent if Chromium needs a separate path there

Preferred media fixture details:

- use a committed `.y4m` or `.mjpeg` fixture for fake camera video
- prefer `.y4m` first for stability
- use a committed `.wav` fixture for fake microphone audio when the browser
  supports file-backed fake audio capture
- if file-backed fake audio is unavailable in the target browser build, fall
  back to the synthetic fake microphone and keep the assertions focused on
  connection state, publish state, and remote media presence

Screen-share note:

- `--use-fake-ui-for-media-stream` handles camera and mic permission prompts,
  but desktop capture needs its own automation path
- Chromium desktop capture may need
  `--auto-select-desktop-capture-source=...` for stable screen-share tests
- screen-share automation must avoid accidentally capturing the wrong Chromium
  window or tab

Hard rules:

- voice and video tests must not depend on a real webcam or microphone
- browser permission prompts must not block the suite
- the suite must still exercise real browser media APIs and real app logic

## Authentication And Navigation Requirements

### R-AUTH-1: Three users can sign up from clean clients

The first smoke path must create three brand-new accounts:

- `alice`
- `bob`
- `charlie`

This must exercise the real signup path, the real recovery-key creation flow,
and the real transition into the main app shell.

### R-AUTH-2: Login lands users in a usable encrypted state

After signup or login, each user must:

- reach the main chat UI
- have working websocket connectivity
- be able to participate in encrypted chat without a hidden warm-up step

If the product blocks encryption behind a device gate, the test must treat that
as deliberate visible state and verify the expected gate instead of proceeding
blindly.

### R-AUTH-3: Recovery key and device trust gating are covered

The extended harness must cover the user-facing trust paths exposed by
`DeviceTrustGate` and `authStore`:

- pending device awaiting approval
- trusted device that still needs local unlock
- recovery-key approval on a new device

At least one scenario must prove that the blocking UI appears when expected and
disappears when the user completes the supported path.

### R-AUTH-4: Session-renewal failure returns the client to a sane sign-in path

The product now exposes a session notice path when an old or non-renewable
session can no longer refresh.

Extended coverage should verify:

- an expired or non-renewable session does not leave the app half-authenticated
- the client is returned to a clear sign-in path
- the session notice is visible
- a fresh sign-in returns the user to a usable state

### R-NAV-1: Server, channel, and DM selection survive refresh

The product stores last-selected server, channel, and conversation in
localStorage. The smoke harness must verify that a reload returns each client to
the expected place instead of dumping them back into a generic empty state.

### R-NAV-2: Thread context survives refresh or is restored clearly

The user should not lose the plot after refreshing mid-thread.

The product may meet this in one of two acceptable ways:

- the same thread panel reopens after refresh
- the user returns to the parent conversation with correct thread summary state
  and can reopen the thread without drift

The harness must record which behavior the product actually promises and assert
that behavior consistently.

## DM Requirements

### R-DM-1: Two users can create and use an encrypted DM

`alice` and `bob` must open a DM and exchange several messages in both
directions.

The suite must verify:

- sent messages appear on both sides
- ordering matches on both sides
- sender labels match on both sides
- the DM appears in each client's conversation list

### R-DM-2: DM history survives refresh and browser restart

After DM traffic exists:

- `alice` refreshes
- `bob` refreshes later
- one side closes and reopens its browser context inside the same run

After each step, the DM transcript must still decrypt and match expected state.

### R-DM-3: DM reactions and threaded replies converge

Inside the DM flow:

- one user reacts to a message
- one user starts a thread or reply flow from the message action row
- both users reply inside that thread

The suite must verify:

- reaction counts and reactor membership match
- the thread entry point is visible
- thread replies stay in the thread view
- thread-only replies do not appear as normal DM messages
- reply counts survive refresh

### R-DM-4: DM typing and unread state behave correctly

Extended coverage must verify:

- typing indicator appears for the remote user
- typing indicator clears after inactivity
- unread badge increments when a DM is not active
- opening the DM clears unread state
- cleared unread state stays cleared after refresh

### R-DM-5: DM attachments decrypt and render correctly

The harness must cover at least one DM attachment and verify:

- upload succeeds
- the receiving client sees the attachment
- the attachment decrypts after reload
- the attachment does not fall back to "expired or unavailable" in the happy path

## Server And Channel Requirements

### R-SERVER-1: An admin can create a server and channels

One user must create a new server during the run and create at least two text
channels through the real UI.

### R-SERVER-2: Users can join the server through supported invite flows

The first harness should use an actual invite path, not a backdoor API call
that bypasses what users do in the product.

Minimum path:

- server owner generates an invite code
- the other users join with that code

P1 or P2 coverage can add:

- expiring invite
- max-use invite
- role-scoped invite if product behavior depends on it

### R-SERVER-3: Server membership and channel visibility converge

After users join:

- the server appears in navigation for every member
- the right channels are visible for every member
- no client needs a manual reload to see the joined server

### R-SERVER-4: Member list and presence update live

Extended coverage should verify:

- member list contains all expected users
- display names stay current
- presence updates propagate
- starting a DM from the member list works and lands in the right conversation

### R-SERVER-5: Permission overrides are enforced across clients

P2 coverage should verify that channel permission overrides actually change what
different members can see and send, not just what the server owner sees in the
settings UI.

### R-SERVER-6: Channel categories and ordering converge across clients

The sidebar already groups by category and stores channel positions. P2 coverage
should verify that when channels are moved, renamed, or re-categorized:

- every client shows the same ordering
- channels stay under the right category
- refresh does not scramble the sidebar

### R-CHANNEL-1: Three users can chat in channels

Inside the created server:

- all three users send messages
- messages converge on all three clients
- order and authorship match

### R-CHANNEL-2: Channel threads stay threaded and off the main timeline

This is a hard requirement because broken threads are easy to miss and make chat
history feel wrong.

The suite must verify:

- the thread button is available from the message action row
- a thread can be opened from a parent message
- thread replies render inside the thread panel
- the main timeline does not show thread-only replies as standard channel posts
- thread summary counts update on every client
- refresh does not flatten the thread

### R-CHANNEL-3: Unread badges and read clearing behave correctly

The harness should verify:

- inactive channels accumulate unread counts
- visiting a channel marks the newest message read
- unread badges clear
- cleared badges do not pop back after refresh

### R-CHANNEL-4: Typing indicators behave correctly

The harness should verify:

- typing appears for the remote user
- the wording stays sane for one and multiple typers
- typing clears after the timeout

### R-CHANNEL-5: Message edit and delete actions converge

At least one channel message must be:

- edited by its author
- deleted by its author

The suite must verify:

- edited content replaces old content on every client
- the edited marker appears
- deleted messages disappear on every client
- refresh keeps the final state

### R-CHANNEL-6: Pin, unpin, and jump-to-message work after refresh

Extended coverage should verify:

- pinning a message updates the pin UI
- pinned message list opens
- clicking a pin jumps to the correct message
- unpin removes it from the list
- pins remain correct after refresh

### R-CHANNEL-7: Disappearing message TTL changes and expiry converge

Extended coverage should verify:

- channel TTL can be changed through the header control
- new messages pick up the TTL
- expiry labels render
- messages disappear on schedule
- all clients converge after expiry

## Emoji, Attachments, Search, And Mentions

### R-EMOJI-1: Custom emoji upload and use work across clients

During the server flow:

- an admin uploads a custom emoji
- at least two users use that emoji

The suite must verify:

- the emoji appears in the server's available emoji set
- the same token resolves on every client
- refresh does not break rendering

### R-EMOJI-2: Custom emoji work in both message bodies and reactions

P1 coverage should verify both paths:

- custom emoji inside message text
- custom emoji as a reaction

### R-MSG-1: Channel and DM attachments work end to end

The harness should cover at least:

- one channel attachment
- one DM attachment

Preferred coverage:

- generic file download
- image preview
- audio preview if the product makes it easy to automate

### R-MSG-2: Image and audio previews decrypt correctly

Where preview UI exists, the harness must verify that:

- preview loads on the sender
- preview loads on the receiver
- preview still loads after refresh

### R-MSG-3: Search can find past messages and jump to them

Extended coverage should verify:

- search finds loaded messages
- search finds indexed historical messages
- selecting a result jumps to the right server, channel, or DM
- the target message is highlighted

### R-MSG-4: Mentions behave correctly

Extended coverage should verify:

- member mention autocomplete inserts the right syntax
- `@everyone` behaves according to permissions
- mentioned users get the expected user-facing signal

If browser notifications are part of the user promise, the harness can stub the
browser permission boundary while still asserting the app behavior.

## Sync And Recovery Requirements

### R-SYNC-1: Reload and reconnect do not leave clients behind

The suite must cover:

- hard page refresh
- websocket reconnect
- browser context restart inside the same run

After each step, the returning client must catch up without manual repair in the
happy path.

### R-SYNC-2: Missing live updates are recovered without manual repair in the happy path

At least one client must miss live updates for a short window while the other
clients keep chatting. When it returns, the product must recover the missing
messages and derived state.

Derived state includes:

- thread counts
- reactions
- unread counts
- custom emoji rendering

### R-SYNC-3: Broken local crypto state has a supported repair path

The harness must include one deliberate repair scenario for a client whose local
crypto state is no longer usable.

Acceptable triggers include:

- clearing selected local encrypted group state
- simulating stale local MLS state
- missing local group membership while ciphertext already exists

The repair path must use a real supported product path, not a hidden plaintext
fallback.

### R-SYNC-4: A client coming back after offline activity catches up cleanly

P1 coverage should close one client entirely while the others keep messaging,
then reopen that client and verify full convergence.

### R-SYNC-5: Pending welcomes and resync requests are exercised for real

The product has real pending welcome and pending resync request endpoints. The
extended harness should drive at least one scenario where those mechanisms are
actually needed instead of only testing the ideal join path.

## Encryption Requirements

### R-E2EE-1: No user-visible decryption failure is acceptable in the happy path

The run must fail if any mainline scenario surfaces:

- `Message unavailable - decryption failed`
- `Message unavailable`
- `Approve this device to read encrypted messages.` in a scenario that is
  supposed to be healthy
- `Conversation encryption is still syncing. Please try again.` in a scenario
  that should already be ready
- `File expired or unavailable` for a fresh attachment

### R-E2EE-2: Recovery flows stay end-to-end encrypted

The harness must not use a test mode that disables encryption, injects
plaintext, or bypasses the same code paths real clients use.

### R-E2EE-3: Trusted-but-locked device unlock is covered

P1 coverage should verify the user path where a trusted device still needs local
unlock before encrypted chats and calls are available.

### R-E2EE-4: Pending device approval with recovery key is covered

P1 coverage should verify:

- device gate appears
- recovery-key approval works
- encrypted chat becomes available afterward

## Voice, Video, And Screen Share Requirements

### R-VOICE-1: Encrypted DM call setup and teardown work

P1 coverage should verify:

- one user starts a DM call
- the other user accepts
- both reach connected or in-call state
- disconnect leaves both clients in a sane state
- refresh or route changes do not leave a ghost in-call UI behind

### R-VOICE-2: Encrypted channel voice join and reconnect work

Channel voice is part of the normal everyday path here, so it belongs in P1.

The harness should verify:

- two or more users join the same voice channel
- participant roster converges
- mute state updates propagate
- one user disconnects and rejoins
- no permanent voice-encryption failure on rejoin

### R-VOICE-3: Camera publish and remote video rendering work

P1 coverage should verify:

- a user can turn on camera in a live call or voice room
- the local preview appears
- remote participants see the published camera feed
- stopping the camera clears the feed cleanly
- reconnect does not leave stale "camera live" UI on either side

The first pass does not need pixel-perfect video analysis, but it must prove
more than "the button changed color." It should check the expected local preview
and remote live-stream surfaces.

### R-VOICE-4: Screen share and share-audio behavior work

P2 coverage should verify:

- a user can start screen share
- remote participants see the share feed
- when share-audio is enabled, the UI reflects that state correctly
- stopping share clears the remote feed and badges

If screen share automation is harder than camera in the first pass, camera
coverage still lands first. Screen share follows as soon as the harness can
drive it reliably.

### R-VOICE-5: Voice and video device failure paths degrade cleanly

P2 coverage should verify user-facing recovery when a requested device is not
available or media startup fails.

The suite should assert that the app shows a sane error state and does not get
stuck half-connected.

## Assertion Requirements

### R-ASSERT-1: Assertions compare exact cross-client state

Helpers must normalize and compare state across clients.

Minimum snapshot content:

- ordered visible root messages
- ordered thread replies
- reaction groups
- unread counts
- selected server, channel, or DM
- custom emoji tokens visible in the transcript

### R-ASSERT-2: The suite fails on duplicates, gaps, and stale counters

The suite must fail when:

- one client has a visible message another client lacks
- the same message appears twice
- a thread count differs across clients
- a reaction count differs across clients
- unread counts disagree with the scenario

### R-ASSERT-3: Known console and network failure signatures fail the run

The harness must collect console and network failures and fail on signatures
known to matter to users, including:

- `InvalidStateError: Invalid state`
- `Commit processing failed`
- `ValidationError: Commit cannot contain an Add proposal for someone already in the group`
- repeated websocket connection failures tied to the app socket
- failed pending-welcome and pending-resync requests in scenarios that should
  recover

The Cloudflare beacon blocker noise and unrelated extension noise should be
filtered so the run only fails on product-relevant signals.

### R-ASSERT-4: The harness records normalized snapshots at key checkpoints

Extended helpers should record state snapshots after:

- signup complete
- DM convergence
- DM refresh convergence
- server join convergence
- channel thread convergence
- reconnect or recovery convergence

This makes failures easier to understand than a raw screenshot alone.

### R-ASSERT-5: The first run proves enough to gate pre-merge CI

The first successful harness is good enough to gate pre-merge CI when:

- it boots the stack itself
- it passes from a clean checkout
- it is stable across repeated local runs
- it passes the full P0 scenario pack

## P0 Scenario Pack

The first merged smoke harness must implement one continuous run with these
steps:

1. Boot a fresh stack.
2. Open three clean browser clients.
3. Sign up `alice`, `bob`, and `charlie`.
4. Verify each reaches the main app.
5. Create a DM between `alice` and `bob`.
6. Exchange several encrypted DM messages in both directions.
7. Add at least one DM reaction.
8. Start a DM thread and post multiple threaded replies.
9. Refresh `alice`; verify the DM state.
10. Refresh `bob`; verify the DM state.
11. Restart one DM client context; verify the DM state again.
12. Create a server as one user.
13. Create at least two text channels.
14. Generate an invite and have the other two users join with it.
15. Verify server and channel visibility on all clients.
16. Send channel messages from all three users.
17. Start a channel thread and post threaded replies.
18. Upload a custom emoji.
19. Use the custom emoji in visible chat behavior.
20. Force one reconnect or missed-update window for one client.
21. Verify every client converges on the same user-visible state.
22. Verify no P0 crypto or sync failure surfaced.

## P1 Scenario Pack

These should land right after the first harness:

1. Typing indicators in DMs and channels.
2. Unread badge accumulation and clearing in DMs and channels.
3. Attachment upload, preview, and reload.
4. Message edit and delete convergence.
5. Pin and jump-to-message behavior.
6. Disappearing message TTL and expiry.
7. Search and jump-to-result.
8. Trusted-but-locked device unlock.
9. Pending-device approval with recovery key.
10. Session-renewal failure and fresh sign-in recovery.
11. Encrypted DM call setup and teardown.
12. Channel voice join, participant convergence, and reconnect.
13. Camera publish with fake media and remote rendering checks.

## P2 Scenario Pack

These expand from "core chat works" into "the product is operationally safe to
move a group onto":

1. Channel permission overrides hiding a channel from one member.
2. Offline catch-up after longer absence.
3. Channel voice join, reconnect, and clean disconnect.
4. Invite expiry and max-use handling.
5. Presence and member-list drift checks.
6. Category and channel ordering drift checks.
7. Screen share and share-audio behavior.
8. Media-device failure and recovery behavior.

## Hard-Fail User Symptoms

These are ship-blocking if they appear in a P0 path:

- missing live messages
- duplicate live messages
- thread replies showing in the main timeline
- messages failing to decrypt after refresh
- attachments failing after a fresh reload
- unread badges stuck or wrong
- invite join requiring a manual refresh to become usable
- custom emoji rendering as raw broken text when the emoji should resolve
- a client becoming permanently out of sync with the others

## Test Data Requirements

The harness should use deterministic seed data for:

- usernames
- server name
- channel names
- invite code capture
- custom emoji name
- message bodies
- file names

Seed messages should be unique enough that search, jump-to-message, and thread
assertions can target them directly.

## Non-Goals For The First Pass

The first harness does not need to cover everything at once.

Out of scope for the first merged pass:

- visual snapshot coverage for the full app
- mobile browser matrix coverage
- large-scale load testing
- external link preview behavior against third-party sites
- exhaustive permissions matrix testing

## Maintenance Rules

- New E2E specs must list the requirement IDs they cover.
- Helper modules should mention the requirement IDs they exist to satisfy.
- If product behavior changes, update this document before changing the test.
- If a requirement gets dropped, the removal must be explicit in git history.
