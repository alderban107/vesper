---
commit_hash: c3d6b83b2b0af299e1aac17c99597ef0cf59761e
analyzed_at: 2026-03-24T01:06:00Z
scope: lib/**/*.ex, test/**/*.exs
files_analyzed: 119
---

## Functions

| File | Function | Signature | Lines | Key Calls |
|------|----------|-----------|-------|-----------|
| lib/vesper/accounts.ex | register_user | (attrs) -> {:ok, User} \| {:error, Changeset} | context | Repo.insert, User.registration_changeset |
| lib/vesper/accounts.ex | authenticate_user | (username, password) -> {:ok, User} \| {:error, :unauthorized} | context | get_user_by_username, User.verify_password |
| lib/vesper/accounts.ex | create_tokens | (user, device) -> {:ok, tokens} | context | Token.generate_access_token, UserToken.build_refresh_token |
| lib/vesper/accounts.ex | refresh_tokens | (refresh_token_b64) -> {:ok, tokens} \| {:error, :invalid_token} | context | Base.url_decode64, UserToken.valid_refresh_token_query |
| lib/vesper/accounts.ex | ensure_device | (user, attrs, trust_state, approval_method) -> {:ok, Device} | context | Repo.insert, Device.changeset |
| lib/vesper/accounts.ex | change_password | (user, old_pw, new_pw, bundle_attrs) -> {:ok, User} | context | User.verify_password, revoke_all_user_tokens |
| lib/vesper/accounts.ex | upsert_search_index_snapshot | (user_id, attrs) -> {:ok, Snapshot} \| {:error, :conflict} | context | CAS via version field |
| lib/vesper/encryption.ex | fetch_and_consume_key_package | (user_id, client_id) -> binary \| nil | context | FOR UPDATE SKIP LOCKED |
| lib/vesper/encryption.ex | publish_group_info | (attrs) -> {:ok, MlsGroupInfo} \| {:error, :epoch_conflict} | context | CAS via previous_epoch |
| lib/vesper/encryption.ex | publish_external_commit_group_info | (attrs) -> {:ok, %{group_info, event}} | context | advisory lock, idempotent commit |
| lib/vesper/encryption.ex | publish_sponsored_transition | (attrs) -> {:ok, result} \| {:error, reason} | context | advisory lock, CAS, idempotent commit+welcome |
| lib/vesper/encryption.ex | store_mls_commit_event | (attrs) -> {:ok, MlsEvent} | context | idempotency_key dedup |
| lib/vesper/encryption.ex | store_mls_remove_event | (attrs, eviction) -> {:ok, MlsEvent} | context | transaction: event + eviction complete |
| lib/vesper/encryption.ex | queue_scope_crypto_evictions | (evictions) -> :ok | context | bulk insert + Oban enqueue |
| lib/vesper/encryption.ex | request_next_pending_crypto_eviction | (scope_kind, scope_id) -> eviction \| nil | context | FOR UPDATE, retry cutoffs |
| lib/vesper/encryption.ex | claim_pending_crypto_eviction | (id, scope, sponsor) -> {:ok, eviction} | context | sponsor != target validation |
| lib/vesper/encryption.ex | complete_pending_crypto_eviction | (id, scope, target, commit_event_id, sponsor) -> {:ok, eviction} | context | verify IDs, purge artifacts |
| lib/vesper/chat.ex | create_message | (attrs) -> {:ok, Message} | context | Runtime.project_message |
| lib/vesper/chat.ex | delete_message | (message) -> {:ok, Message} | context | cascade attachment cleanup |
| lib/vesper/chat.ex | create_conversation | (creator_id, participant_ids, opts) -> {:ok, DmConversation} | context | dedup direct DMs, Runtime.ensure_room |
| lib/vesper/chat.ex | delete_expired_messages | () -> :ok | context | purge by expires_at + orphan blobs |
| lib/vesper/servers.ex | create_server | (user, attrs) -> {:ok, server} | context | auto-provision channels, roles, membership |
| lib/vesper/servers.ex | user_can? | (user_id, server_id, perm_bit) -> boolean | context | PermissionsCache ETS lookup |
| lib/vesper/servers.ex | redeem_invite | (code, user_id) -> {:ok, membership} | context | expiry, usage limit, ban check |
| lib/vesper/runtime.ex | project_message | (message) -> {:ok, RoomEvent} | context | next_room_seq!, Sync.append |
| lib/vesper/voice/room.ex | join | (room_id, user_id, channel_pid) -> {:ok, offer_sdp, tracks} | GenServer | PeerConnection, SDP offer |
| lib/vesper/sync.ex | list_scope_changes_since | (user_id, after_id) -> scope_changes | context | aggregates channel/dm/server sets |

## Schemas

| File | Name | Kind | Key Fields |
|------|------|------|------------|
| lib/vesper/accounts/user.ex | User | schema | id, username, password_hash, crypto fields (7 binary), avatar_url, status |
| lib/vesper/accounts/device.ex | Device | schema | id, client_id, trust_state (trusted/pending/revoked), push fields |
| lib/vesper/accounts/token.ex | Token | Joken config | access_token TTL 900s, claims: sub, device_id, device_trust_state |
| lib/vesper/accounts/user_token.ex | UserToken | schema | token (32 random bytes), context, 30-day validity |
| lib/vesper/encryption/key_package.ex | KeyPackage | schema | user_id, client_id, key_package_data (binary), consumed |
| lib/vesper/encryption/mls_event.ex | MlsEvent | schema | group_id, event_type, payload (map), idempotency_key |
| lib/vesper/encryption/mls_group_info.ex | MlsGroupInfo | schema | group_id (unique), group_info_data, epoch, previous_epoch |
| lib/vesper/encryption/pending_welcome.ex | PendingWelcome | schema | welcome_data, group_id, recipient_id, dual-mode upsert |
| lib/vesper/encryption/pending_crypto_eviction.ex | PendingCryptoEviction | schema | 6-state FSM, scope_kind, target/sponsor fields |
| lib/vesper/chat/message.ex | Message | schema | ciphertext, client_nonce, mls_epoch, channel_id XOR conversation_id |
| lib/vesper/chat/attachment.ex | Attachment | schema | storage_key (SHA256), encrypted, expires_at |
| lib/vesper/chat/file_storage.ex | FileStorage | module | SHA256 content-addressed, priv/uploads/ |
| lib/vesper/servers/server.ex | Server | schema | name, invite_code, owner_id |
| lib/vesper/servers/channel.ex | Channel | schema | name, type (text/voice/category), disappearing_ttl |
| lib/vesper/servers/role.ex | Role | schema | permissions (bitfield), position |
| lib/vesper/servers/permissions.ex | Permissions | module | bitfield constants, administrator=16384 |
| lib/vesper/servers/permissions_cache.ex | PermissionsCache | GenServer+ETS | user_id,server_id => perms, PubSub invalidation |
| lib/vesper/servers/member_cache.ex | MemberCache | GenServer+ETS | server_id => MapSet(user_ids) |
| lib/vesper/runtime/room.ex | Room | schema | kind (:channel/:dm), current_seq, last_message fields |
| lib/vesper/runtime/room_event.ex | RoomEvent | schema | event_type, room_seq, message_id link |
| lib/vesper/voice/room.ex | Voice.Room | GenServer | max 25 participants, 5min idle, ExWebRTC PeerConnections |

## Routes

| Method | Path | File | Handler | Auth |
|--------|------|------|---------|------|
| POST | /api/v1/auth/register | auth_controller.ex | register | none |
| POST | /api/v1/auth/login | auth_controller.ex | login | none |
| POST | /api/v1/auth/refresh | auth_controller.ex | refresh | none |
| POST | /api/v1/auth/logout | auth_controller.ex | logout | none |
| POST | /api/v1/auth/recover | auth_controller.ex | recover | none |
| POST | /api/v1/auth/recover/reset | auth_controller.ex | recover_reset | none |
| GET | /api/v1/auth/me | auth_controller.ex | me | authenticated |
| PUT | /api/v1/auth/profile | auth_controller.ex | update_profile | authenticated |
| PUT | /api/v1/auth/password | auth_controller.ex | change_password | authenticated |
| GET | /api/v1/auth/devices | auth_controller.ex | devices | authenticated |
| POST | /api/v1/auth/devices/:id/approve | auth_controller.ex | approve_device | trusted_device |
| POST | /api/v1/auth/devices/:id/revoke | auth_controller.ex | revoke_device | trusted_device |
| GET | /api/v1/users/search | user_controller.ex | search | none (api only) |
| GET | /api/v1/servers | server_controller.ex | index | authenticated |
| POST | /api/v1/servers | server_controller.ex | create | authenticated |
| POST | /api/v1/invites/redeem | server_controller.ex | join_by_invite | authenticated |
| GET | /api/v1/messages | message_controller.ex | index | authenticated |
| POST | /api/v1/conversations | conversation_controller.ex | create | authenticated |
| POST | /api/v1/attachments | attachment_controller.ex | create | authenticated |
| GET | /api/v1/attachments/:id | attachment_controller.ex | show | authenticated |
| GET | /api/v1/key-packages/:user_id | key_package_controller.ex | show | trusted_device |
| POST | /api/v1/key-packages | key_package_controller.ex | create | trusted_device |
| GET | /api/v1/mls-events/:channel_id | mls_event_controller.ex | index | trusted_device |
| GET | /api/v1/group-info/:scope_id | group_info_controller.ex | show | trusted_device |
| PUT | /api/v1/group-info/:scope_id | group_info_controller.ex | upsert | trusted_device |
| POST | /api/v1/mls-sponsored-transition/:scope_id | sponsored_transition_controller.ex | create | trusted_device |
| GET | /api/v1/sync | sync_controller.ex | index | authenticated |
| POST | /api/v1/sync/scopes | scope_sync_controller.ex | create | authenticated |
| GET | /api/v1/sync/urgent | urgent_sync_controller.ex | index | authenticated |
| GET | /api/v1/unread | unread_controller.ex | index | authenticated |
| GET | /health | health_controller.ex | check | none |

## WebSocket Channels

| Topic | Module | Auth |
|-------|--------|------|
| chat:channel:* | ChatChannel | member + view permission |
| dm:* | DmChannel | participant |
| voice:channel:* | VoiceChannel | member |
| voice:dm:* | VoiceChannel | participant |
| user:* | UserChannel | self only |
| presence:server:* | ServerPresenceChannel | member |
| scope:dm:* | ScopeChannel | participant |

## Oban Workers

| Worker | Queue | Schedule | Purpose |
|--------|-------|----------|---------|
| ExpireMessages | default | every minute | Delete messages past expires_at |
| ExpireAttachmentBlobs | default | daily 3am | Delete expired/orphaned blobs |
| PurgeKeyPackages | default | daily | Delete consumed packages >24h |
| PurgeWelcomes | default | daily | Delete old pending welcomes >24h |
| PurgeExpiredTokens | default | daily | Delete refresh tokens >30d |
| ProcessPendingCryptoEvictions | crypto_evictions | on-demand | Broadcast eviction requests |
