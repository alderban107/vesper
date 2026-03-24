# Findings — vesper-full-server (1M Scale Priority)

## Finding 1: Sync fan-out writes O(N) UserSyncEvent rows per message

**Severity:** HIGH (at 1M scale)
**Confidence:** HIGH
**Location:** `lib/vesper/sync.ex` (append_scope_events), `lib/vesper/runtime.ex` (project_message)
**Consensus:** 3/8 personas (upgraded to HIGH for 1M target)

**Evidence:**
Every message insert calls `Sync.append_scope_events(member_ids, ...)` which creates one `UserSyncEvent` row per member. A server with 10,000 members generates 10,000 rows per message. At 1M users across many servers with active messaging, this produces millions of sync event rows per minute. The sync table becomes the write bottleneck.

**Recommendation:**
Replace per-user sync events with a shared event log. Each scope (channel/DM) gets a single event stream. Users track their cursor position (last-seen event ID) rather than having dedicated rows. This reduces N writes per message to 1 write per message.

Architecture:
- `scope_events` table: `{id (serial), scope_kind, scope_id, event_type, payload, inserted_at}`
- `user_sync_cursors` table: `{user_id, scope_id, last_seen_event_id}` (upsert on read)
- Query: `SELECT * FROM scope_events WHERE scope_id IN (user_scopes) AND id > cursor`

**Persona Votes:**
| Persona | Vote | Note |
|---------|------|------|
| Performance Engineer | confirm | Primary write bottleneck at scale |
| Reliability Engineer | confirm | Row count explosion causes vacuum pressure |
| Elixir/OTP Specialist | confirm | Ecto insert_all helps but doesn't fix O(N) |
| Devil's Advocate | confirm | At 1M users this is not theoretical |

---

## Finding 2: No rate limiting on authentication endpoints

**Severity:** HIGH
**Confidence:** HIGH
**Location:** `lib/vesper_web/router.ex` (auth routes), `lib/vesper_web/controllers/auth_controller.ex`
**Consensus:** 7/8 personas

**Evidence:**
Zero rate-limiting plugs on login, register, refresh, recover, or recover_reset. At 1M scale with internet-facing endpoints, this enables credential stuffing, Argon2-based CPU exhaustion (DoS), and brute-force attacks.

**Recommendation:**
Add `PlugAttack` or `Hammer` rate limiting:
- Login: 5 attempts per username per minute, 20 per IP per minute
- Register: 3 per IP per minute
- Recovery: 3 per IP per 10 minutes
- Refresh: 60 per token per minute

Consider using Redis-backed counters for rate limiting across multiple nodes at 1M scale.

**Persona Votes:**
| Persona | Vote | Note |
|---------|------|------|
| Security Analyst | confirm | Top security priority |
| Architecture Reviewer | confirm | |
| Reliability Engineer | confirm | Argon2 DoS vector |
| Elixir/OTP Specialist | confirm | |
| Cryptography Reviewer | confirm | |
| Devil's Advocate | confirm (with condition) | Self-hosted, but still needs it |
| Performance Engineer | abstain | |
| Data Integrity Analyst | abstain | |

---

## Finding 3: Voice Room GenServer mixes control plane and data plane

**Severity:** HIGH (at 1M scale)
**Confidence:** HIGH
**Location:** `lib/vesper/voice/room.ex`
**Consensus:** 3/8 personas (upgraded for scale)

**Evidence:**
The Room GenServer handles join/leave (control) AND RTP packet routing (data) in the same process mailbox. With 25 participants each sending audio at 50 packets/sec, the mailbox processes 1,250+ messages/sec. A slow control operation (PeerConnection setup) blocks all RTP forwarding. At scale with hundreds of concurrent rooms, this is a CPU and latency bottleneck.

**Recommendation:**
Separate into two processes per room:
1. `Voice.Room.Control` (GenServer) — handles join/leave/media state, low frequency
2. `Voice.Room.Router` (dedicated process or port) — handles RTP forwarding only, high frequency

Alternative: Use ExWebRTC's forwarding capabilities to bypass the GenServer for RTP data entirely, routing packets directly between PeerConnections via process links.

**Persona Votes:**
| Persona | Vote | Note |
|---------|------|------|
| Performance Engineer | confirm | SFU bottleneck |
| Reliability Engineer | confirm | Control op blocking data is a latency cliff |
| Elixir/OTP Specialist | confirm | Classic GenServer anti-pattern for media |

---

## Finding 4: Low test coverage across critical paths

**Severity:** HIGH
**Confidence:** HIGH
**Location:** `test/` directory (7 test files for 100+ source files)
**Consensus:** 8/8 personas (unanimous)

**Evidence:**
Only 7 test files exist. Missing coverage for: authentication (login, register, token refresh, device trust transitions), permissions (RBAC, channel overrides), invite redemption, voice room lifecycle, sync controller, server CRUD, channel CRUD, crypto eviction FSM. At 1M scale, untested code paths will fail in unexpected ways under load.

**Recommendation:**
Prioritize tests for:
1. Auth flows (login, refresh, device trust transitions) — security-critical
2. Permission computation (bitfield ORing, channel overrides) — authorization-critical
3. Sync controller (cursor handling, scope changes) — scale-critical
4. Encryption context (CAS, idempotency, eviction FSM) — correctness-critical

---

## Finding 5: PermissionsCache cold-start serialized through single GenServer

**Severity:** MEDIUM (HIGH at 1M scale)
**Confidence:** MEDIUM
**Location:** `lib/vesper/servers/permissions_cache.ex`

**Evidence:**
On ETS miss, every requesting process calls `GenServer.call(via, {:compute, user_id, server_id})`. After a deployment restart (or cache invalidation of a large server), thousands of concurrent requests serialize through one GenServer process. At 1M users, a server with 50K members restarting causes a thundering herd through the permissions GenServer.

**Recommendation:**
- Use `Task.async_stream` for batch warm-up on startup
- On miss, fall back to direct DB read (bypass GenServer) using `Repo.one/1` with the same query
- Add a `:via` registry to shard the GenServer by server_id (multiple cache processes)
- Consider LRU eviction with a size cap (e.g., `ConCache` or `Cachex`)

---

## Finding 6: No rate limit on recovery key verification

**Severity:** HIGH
**Confidence:** HIGH
**Location:** `lib/vesper_web/controllers/auth_controller.ex:192-211`
**Consensus:** 5/8 personas

**Evidence:**
`POST /api/v1/auth/recover` accepts `recovery_key_hash` and returns `encrypted_recovery_bundle` if valid. No rate limiting. Enables offline brute-force of recovery keys by testing hashes against the endpoint.

**Recommendation:**
Rate limit to 3 attempts per IP per 10 minutes. Add exponential backoff on failure. Log all recovery attempts for audit.

---

## Finding 7: Unlinked attachments accessible to any authenticated user

**Severity:** MEDIUM
**Confidence:** HIGH
**Location:** `lib/vesper_web/controllers/attachment_controller.ex:97`
**Consensus:** 5/8 personas

**Evidence:**
`authorized_for_attachment?(_user_id, %{message: nil}), do: true` — any authenticated user can download any unlinked attachment if they know/guess the UUID. At 1M users, the probability of UUID collision is still negligible, but the lack of uploader tracking means any auth'd user can probe attachment IDs.

**Recommendation:**
Add `uploader_id` to Attachment schema. Restrict unlinked attachment access to the original uploader.

---

## Finding 8: FileStorage uses local filesystem — no horizontal scaling

**Severity:** MEDIUM (HIGH at 1M scale)
**Confidence:** HIGH
**Location:** `lib/vesper/chat/file_storage.ex:7`

**Evidence:**
`@upload_dir "priv/uploads"` with `File.cp!`/`File.rm!` — local filesystem only. At 1M users, multiple server nodes need shared file access. Local FS means a single-node bottleneck for all file operations.

**Recommendation:**
Abstract FileStorage behind a behaviour:
```elixir
defmodule Vesper.Chat.FileStorage.Behaviour do
  @callback store(source_path, filename) :: {:ok, key} | {:error, term}
  @callback get_url(key) :: String.t()
  @callback delete(key) :: :ok
end
```
Implement S3-compatible backend (MinIO for self-hosted, AWS S3 for cloud). Use presigned URLs for direct client upload/download to bypass the server entirely.

---

## Finding 9: GroupInfo epoch inflation by compromised client

**Severity:** MEDIUM
**Confidence:** MEDIUM
**Location:** `lib/vesper/encryption.ex` (publish_group_info)
**Consensus:** 3/8 personas

**Evidence:**
When `previous_epoch` is not specified, the server accepts any epoch > current epoch. A compromised client publishing epoch=999999999 prevents all other clients from publishing GroupInfo until they reach that epoch.

**Recommendation:**
Add a maximum epoch delta check: `new_epoch <= stored_epoch + 100` (configurable). Reject publishes that jump more than the delta.

---

## Finding 10: Voice room crash loses all state with no recovery

**Severity:** MEDIUM
**Confidence:** HIGH
**Location:** `lib/vesper/voice/room.ex:2` (restart: :temporary)
**Consensus:** 3/8 personas

**Evidence:**
Voice Room is `restart: :temporary` — crash means all participants disconnected with no state recovery. At 1M scale with hundreds of concurrent voice rooms, room crashes become statistically frequent.

**Recommendation:**
- Change to `restart: :transient` (restart on non-normal exit)
- Persist minimal room state (participant list) to ETS or Redis for fast recovery
- Add client-side automatic reconnect with exponential backoff

---

## Finding 11: Attachment content_type trusted from client

**Severity:** MEDIUM
**Confidence:** HIGH
**Location:** `lib/vesper_web/controllers/attachment_controller.ex:31`
**Consensus:** 2/8 (Probable)

**Evidence:**
Client-provided content_type stored directly, used in response Content-Type header. For unencrypted attachments, enables content-type spoofing.

**Recommendation:**
Use file magic bytes (`:file.mime_type/1` or `Filetype` library) to detect actual content type.

---

## Finding 12: User search endpoint exposes user existence without auth

**Severity:** MEDIUM
**Confidence:** HIGH
**Location:** `lib/vesper_web/controllers/user_controller.ex:5`
**Consensus:** 2/8 (Probable)

**Evidence:**
Public endpoint returns 0 or 1 results, enabling username enumeration.

**Recommendation:**
Move behind authenticated pipeline.

---

## Finding 13: CORS default allows all origins

**Severity:** LOW
**Confidence:** MEDIUM
**Location:** `lib/vesper_web/endpoint.ex:63`
**Consensus:** 2/8 (Probable)

**Recommendation:**
Make CORS origins configurable via environment variable with restrictive default.

---

## Finding 14: Encryption context is a god module (~1560 lines)

**Severity:** MEDIUM
**Confidence:** HIGH
**Location:** `lib/vesper/encryption.ex:1`
**Consensus:** 2/8 (Probable)

**Recommendation:**
Extract into focused sub-modules for maintainability.

---

## Finding 15: Repo.insert! inside Repo.transaction anti-pattern

**Severity:** LOW
**Confidence:** HIGH
**Location:** `lib/vesper/servers.ex:33-96`
**Consensus:** 3/8

**Recommendation:**
Migrate to `Ecto.Multi` for clean error propagation.

---

## Finding 16: DM conversation dedup race condition

**Severity:** LOW
**Confidence:** HIGH
**Location:** `lib/vesper/chat.ex` (create_conversation)
**Consensus:** 2/8 (Probable)

**Recommendation:**
Add unique constraint on sorted participant pair for direct DMs.
