# Matrix-Core Evaluation for Vesper

This document asks a narrower question than "should Vesper become Matrix-compatible?"
The answer to that is no. The real question is whether Vesper should adopt a
Matrix-like core inside one product box: no federation, no Matrix wire
compatibility, but the same kind of event model, sync model, device model, and
builder surface.

The short version:

- Vesper should copy Matrix's room/event/state model.
- Vesper should copy Matrix's sync and to-device split.
- Vesper should copy Matrix's relations model for threads, edits, reactions,
  receipts, and typing.
- Vesper should not copy federation.
- Vesper should not copy Megolm room crypto unless Vesper decides Matrix
  compatibility matters more than cryptographic cleanup.
- The most promising target is "Matrix-core with Vesper-owned transport and
  server semantics, plus a fresh encryption decision."

## Official Matrix spec sources used

- Client-server API: https://spec.matrix.org/latest/client-server-api/
- Application service API: https://spec.matrix.org/latest/application-service-api/

The sections that matter most for this comparison are:

- Rooms, timelines, and state events
- `/_matrix/client/v3/sync`
- send-to-device messaging
- event relationships and threading
- receipts and typing notifications
- device keys, one-time keys, cross-signing, secret storage, and key backup
- application services

## What Matrix gives you at the core

### 1. Room, event, and state model

Matrix splits room data into a few clean buckets:

- timeline events: chat messages and timeline-visible actions
- state events: room-scoped named state, keyed by event type plus state key
- ephemeral events: typing, receipts, and similar client-facing updates that do
  not become part of durable room history
- to-device events: encrypted device-to-device control traffic that is not part
  of room history

That split is the best part of Matrix for a product like Vesper.

It gives you a stable shape for building more than chat:

- chat and threads fit in timeline events
- permissions, room settings, pinned items, widgets, and app state fit in state
  events
- typing and receipts fit in ephemeral events
- verification, key gossip, secret requests, and account-device control fit in
  to-device events

Vesper today already has some of these ideas, but the shapes are spread across
handwritten endpoints, store logic, and ad hoc payloads. Matrix has a cleaner
object model for this part of the system.

### 2. Incremental sync

The Matrix `/sync` API gives each client one place to ask:

- what changed in rooms
- what state changed
- what ephemeral events arrived
- which to-device events arrived
- which device lists changed
- how many one-time keys remain

That is a better fit for offline recovery and multi-device convergence than
Vesper's current mix of REST fetches, Phoenix broadcasts, pending welcome
lookups, and repair code.

For a non-federated Vesper, the lesson is not "copy `/sync` byte for byte." The
lesson is "make sync a first-class server product with explicit delta types."

### 3. To-device messaging

Matrix has a distinct send-to-device channel for messages that are about devices
or users rather than rooms:

- verification requests
- room key sharing
- secret requests
- backup coordination
- device-level trust updates

Vesper currently overloads room channels and pending welcome storage to recover
from missing state. That works for MLS bootstrap, but it does not give Vesper a
general control plane for devices. Matrix does.

If Vesper wants multiple devices, recovery flows, and future bots or apps that
need secure control traffic, a to-device lane is hard to avoid.

### 4. Relations and threadable history

Matrix models edits, reactions, replies, and threads as relationships between
events. This matters for builder ergonomics.

Once the system understands "this event points at that event with relation type
X," a lot of product features become easier to add without inventing one new
table and one new websocket payload shape per feature.

For Vesper, this points to a clean target:

- keep timeline events as the base object
- add a Vesper-native relations layer
- let thread roots, reactions, edits, and receipts all hang off that model

The benefit is not just code cleanliness. It also makes search, notifications,
unread logic, and future apps line up around the same event graph.

### 5. Application services and extensibility

Matrix application services are a real extensibility boundary. They are clunky in
some places and shaped by federation-era decisions, but they prove the value of
having:

- a typed event stream
- namespace ownership
- privileged service accounts
- a clear ingress path for bots and bridges

For Vesper, the exact Matrix application-service API is the wrong thing to copy.
The right thing to copy is the boundary:

- stable typed events
- stable sync surface
- stable auth/capability model
- service identities with explicit permissions

If Vesper wants to be something people build on top of, this boundary matters
more than whether the server uses Phoenix channels or HTTP long-poll under the
hood.

## What Matrix E2EE adds on top of that core

The Matrix spec splits encrypted messaging into a few linked parts:

- device keys and one-time keys published through client-server APIs
- Olm for device-to-device encrypted traffic
- Megolm for room message history
- send-to-device delivery for key exchange and verification traffic
- cross-signing for user-owned trust over devices
- secret storage and key backup for restoring encrypted history

That stack is tightly integrated with Matrix's multi-device story. A client does
not just decrypt room events. It also manages:

- which devices exist for each user
- whether those devices are trusted
- which room keys each device is missing
- how secrets get restored on a new device
- how backup and verification interact

This is the strongest argument for copying Matrix-core carefully rather than
copying Matrix whole. The device-control ideas are valuable. The room-history
crypto choice is where Vesper still has room to choose.

## Where Matrix hurts

### 1. Room E2EE is tied to device complexity

Matrix room E2EE grew around Olm plus Megolm:

- Olm handles device-to-device encryption
- Megolm handles room message history

That split solved a real problem for Matrix, but it left Matrix clients carrying
a large state machine:

- device key tracking
- one-time key upload and claim
- room key requests and gossip
- key withholding cases
- cross-signing state
- secret storage
- backup restore
- verification UX

For a non-federated Vesper, there is no reason to inherit all of that unless the
benefits clearly beat MLS.

### 2. Megolm history handling is builder-friendly, but crypto-cleanliness suffers

Megolm's appeal is straightforward history and multi-device behavior for rooms.
Its downside is also straightforward: the room encryption story is older and less
clean than MLS. Matrix had to build a lot of supporting machinery around it.

If Vesper copies Matrix-core and also copies Megolm, Vesper gets a more
Matrix-like client shape, but it also inherits much of Matrix's long tail:

- session-key backup complexity
- room-key sharing complexity
- verification pressure
- more ways for history readability to depend on device state

### 3. The public model is elegant; the operational model is heavy

Matrix's event model is pleasant to build on. Matrix's full protocol stack is
heavy because it was built for open federation, partial trust, remote homeserver
joins, and long compatibility tails.

That distinction matters here. Vesper can take the event model and sync model
without taking the federation baggage.

## Vesper today, against that baseline

Vesper already has a few strong pieces:

- one room-level encryption system across channels, DMs, and voice
- a server that does not read room content
- per-room persisted crypto state
- client-side encrypted file handling
- thread UI and encrypted reactions

Vesper also has gaps that a Matrix-core model would help:

- no general to-device control plane
- limited multi-device semantics
- resync and repair flows live in feature code rather than one sync/control
  layer
- threads, edits, reactions, receipts, and other message relations do not yet
  share one formal event graph
- the product does not yet expose a stable platform surface for bots, apps, or
  services

## Architecture options

### Option A: Vesper keeps its current shape and adds features piecemeal

Pros:

- least short-term churn
- keeps current MLS work
- lowest migration risk

Cons:

- builder surface stays fragmented
- device and sync semantics stay scattered
- future product features keep turning into feature-specific pipes

This is the weakest option if the goal is "non-federated Matrix in a Vesper box."

### Option B: Matrix-core plus Olm/Megolm

Pros:

- closest to Matrix's native mental model
- easiest to mirror Matrix features directly
- easiest path if future Matrix compatibility ever re-enters scope

Cons:

- inherits Matrix's room-key and device-key complexity
- drags Vesper toward verification, backup, and key-gossip problems it does not
  currently need
- gives up one of Vesper's strongest bets, which is "use a more modern group
  primitive"

This option only wins if Vesper values Matrix compatibility or exact Matrix
semantics more than cleaner room crypto.

### Option C: Matrix-core plus MLS room crypto

Pros:

- keeps the best part of Matrix for product shape
- keeps the best part of Vesper's current crypto direction
- separates builder-friendly data modeling from the Megolm-specific baggage
- gives Vesper a clean way to add devices, sync, apps, and bots without backing
  into Matrix's full E2EE tangle

Cons:

- harder migration and design work than copying Matrix whole
- some Matrix client assumptions stop being reusable
- device bootstrap, history restore, and backup flows need fresh design work on
  top of MLS

This is the strongest balanced option.

### Option D: Matrix-core hybrid

This option keeps Matrix-core as the product model, but allows different crypto
choices per lane:

- room history crypto
- device-control crypto
- voice/media-control crypto

This has one real use: Vesper may still want an Olm-like or HPKE-based
device-to-device control lane even if room history uses MLS.

That is a good hybrid. A room-history split that reintroduces Megolm for chat
while MLS stays elsewhere is much less compelling.

## Recommendation

Vesper should adopt a Matrix-like core, but keep ownership of the crypto choice.

The recommended target is:

- Matrix-style room/event/state model
- Matrix-style sync split
- Matrix-style to-device control plane
- Matrix-style relations model
- Vesper-owned non-federated server semantics
- MLS remains the lead candidate for room history encryption
- a separate device-control encryption lane stays allowed

That means Vesper should act like a Matrix-derived product architecture, not a
Matrix protocol clone.

### Why this recommendation wins

The builder story comes from the event model, not from Megolm.

The sync story comes from explicit delta categories, not from federation.

The device story comes from having a to-device lane plus trust and backup
primitives, not from keeping Matrix's exact room-crypto stack.

The part of Matrix that makes Vesper more buildable is the object model.
The part of Matrix that most often makes clients painful is the room E2EE stack
wrapped around device management and history repair.

## What Vesper should copy

- room timeline events
- room state events
- ephemeral events
- to-device events
- sync batch tokens
- event relations
- service/bot capability boundary
- device registry and device trust state
- encrypted secret storage and backup concepts

## What Vesper should leave behind

- federation
- Matrix wire compatibility
- homeserver-to-homeserver assumptions
- appservice registration as-is
- Megolm by default, unless a later evaluation shows MLS causes worse product
  behavior than expected

## Concrete implementation target

### 1. Core data model

Define Vesper-native event primitives:

- `TimelineEvent`
- `StateEvent`
- `EphemeralEvent`
- `ToDeviceEvent`
- `Relation`
- `SyncBatch`

These should become the stable internal model first, then the stable builder API.

### 2. Room and app model

Use rooms as the container for:

- timeline history
- scoped state
- permissions
- apps/widgets/plugins
- room-local automation

This gets Vesper much closer to "platform you can build on top of" than its
current feature-first shape.

### 3. Device model

Add a formal device registry:

- per-device keys
- trust state
- revoke state
- backup and restore metadata

Room crypto can still stay MLS. The device model does not require Megolm.

### 4. Sync model

Create one Vesper sync API that returns:

- room timeline deltas
- state deltas
- ephemeral deltas
- to-device deltas
- device-list changes
- crypto health changes

That should replace the current pattern where recovery logic is spread across
REST reads, websocket handlers, and one-off pending-item lookups.

### 5. Extensibility model

Expose typed events and capabilities to builders:

- bots
- plugins
- app backends
- future embedded apps

The API should be Vesper-specific, but the shape should be close enough to Matrix
that its good design instincts still apply.

## Phased roadmap

### Phase 1: Adopt Matrix-core data modeling

- write Vesper-native event taxonomy
- define room state model
- define relations model
- define sync batch model
- define to-device event model

### Phase 2: Rebuild sync and control flow around that model

- add one sync surface
- move receipts, typing, repair notices, and crypto deltas into explicit channels
- add to-device transport

### Phase 3: Settle room crypto

- run a focused MLS-vs-Megolm evaluation for room history, device restore, and
  multi-device behavior inside the new Matrix-core model
- keep MLS unless Megolm shows a decisive product advantage

### Phase 4: Add device trust and backup

- device registry
- secret storage
- backup metadata
- trusted-device bootstrap
- recovery flow

### Phase 5: Open the builder surface

- typed event SDK
- bot/app capability model
- service identities
- room-scoped app state and permissions

## Final call

If the goal is "non-federated Matrix that lives inside Vesper and is pleasant to
build on top of," Vesper should copy Matrix's structural ideas first and treat the
encryption stack as a second decision.

The likely end state is Matrix-core plus MLS rooms, with a separate device-control
lane that takes cues from Matrix's to-device and secret-management flows.

That gives Vesper a better product core, a better builder surface, and a cleaner
chance to avoid the part of Matrix people spend years trying to sand down.
