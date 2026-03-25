---
commit_hash: c3d6b83b2b0af299e1aac17c99597ef0cf59761e
---

## Module Dependency Graph

| Module | Depends On | Depended By |
|--------|-----------|-------------|
| Vesper.Accounts | Repo, User, Device, Token, UserToken, SearchIndexSnapshot | AuthController, UserController, Auth plug, UserSocket |
| Vesper.Encryption | Repo, Accounts.User, Servers.{Server,Channel}, Chat.DmConversation, ProcessPendingCryptoEvictions | KeyPackageController, MlsEventController, GroupInfoController, PendingWelcomeController, SponsoredTransitionController, ChatChannel, DmChannel |
| Vesper.Chat | Repo, Runtime, Sync, Message, Attachment, DmConversation, DmParticipant, FileStorage | MessageController, ConversationController, AttachmentController, ChatChannel, DmChannel |
| Vesper.Servers | Repo, Permissions, PermissionsCache, MemberCache, Encryption, Runtime, Sync, all server schemas | ServerController, ChannelController, EmojiController, ChatChannel |
| Vesper.Runtime | Repo, Room, RoomEvent, RoomRelation, RoomStateEvent, Sync | Chat, Servers, SyncController, ScopeSyncController |
| Vesper.Sync | Repo, UserSyncEvent, SyncCursor | Runtime, Chat, Servers, SyncController |
| Vesper.Voice | Voice.Room, Voice.RoomSupervisor, Registry | VoiceController, VoiceChannel |
| PermissionsCache | ETS, PubSub, Repo, Permissions | Servers, ChatChannel |
| MemberCache | ETS, PubSub, Repo | Servers, ChatChannel |

## Call Graph (Critical Paths)

| Caller | Callee | Type | Risk Areas |
|--------|--------|------|------------|
| AuthController.login | Accounts.authenticate_user | sync | timing attack if Argon2 short-circuits |
| AuthController.login | Accounts.ensure_device | sync | trust_state assignment |
| Auth plug | Token.verify_access_token | sync | JWT verification |
| Auth plug | Accounts.get_user_device | sync | device revocation check |
| ChatChannel.new_message | Chat.create_message | sync | message insertion + projection |
| Chat.create_message | Runtime.project_message | sync | room_seq atomicity |
| Runtime.project_message | Sync.append_scope_events | sync | N user sync events |
| GroupInfoController.upsert | Encryption.publish_group_info | sync | CAS epoch_conflict |
| GroupInfoController.upsert | Encryption.publish_external_commit_group_info | sync | advisory lock + CAS |
| SponsoredTransitionController.create | Encryption.publish_sponsored_transition | sync | advisory lock + CAS + welcome + remove |
| ChatChannel.mls_commit | Encryption.store_mls_commit_event | sync | idempotency key |
| ChatChannel.mls_eviction_claim | Encryption.claim_pending_crypto_eviction | sync | sponsor validation |
| Servers.user_can? | PermissionsCache.has_permission? | sync | ETS read |
| PermissionsCache.get | Repo (on miss) | sync | DB query on cold cache |
| Voice.join_room | Voice.Room.join | GenServer call | PeerConnection creation |
| Voice.Room.join | ExWebRTC.PeerConnection | sync | SDP offer generation |
| ProcessPendingCryptoEvictions | Encryption.request_next_pending_crypto_eviction | sync | FOR UPDATE |

## Data Flows

| Source | Transform | Sink | Risk Areas |
|--------|-----------|------|------------|
| HTTP params (username, password) | Argon2 hash | users.password_hash | timing on verify |
| HTTP params (crypto fields) | Base64.decode64 | users.* binary fields | invalid base64 → 400 |
| HTTP params (ciphertext) | Base64.decode64 | messages.ciphertext, mls_events.payload | opaque relay, no validation |
| HTTP multipart (file) | SHA256 hash | priv/uploads/{hash} | no filename validation, content-addressed |
| WebSocket params (ciphertext) | Base64.decode64 | chat broadcast | no server-side decryption |
| JWT claims (sub, device_id) | Token.verify_access_token | conn.assigns.current_user | expired token, revoked device |
| Refresh token (base64) | url_decode64, DB lookup | new token pair | rotation: old deleted |
| Invite code | Servers.redeem_invite | memberships table | expiry, usage limit, ban check |
| User permissions | PermissionsCache ETS | authorization decisions | stale cache until PubSub invalidation |
| Room events | Runtime.project_message | room_events + user_sync_events | seq atomicity |
| MLS group_info | CAS (previous_epoch) | mls_group_info table | epoch_conflict on race |
| Crypto eviction | FSM transitions | pending_crypto_evictions | sponsor != target invariant |
