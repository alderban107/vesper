---
commit_hash: c3d6b83b2b0af299e1aac17c99597ef0cf59761e
---

## Clusters

| Cluster | Files | Key Entities | External Deps | Risk Areas |
|---------|-------|-------------|---------------|------------|
| Authentication | accounts.ex, user.ex, device.ex, token.ex, user_token.ex, auth_controller.ex, auth.ex plug, require_trusted_device.ex plug | User, Device, Token, UserToken | Argon2, Joken | JWT signing secret, token rotation, device trust transitions, timing attacks |
| MLS Encryption | encryption.ex, key_package.ex, mls_event.ex, mls_group_info.ex, pending_*.ex, group_info_controller.ex, sponsored_transition_controller.ex | MlsEvent, MlsGroupInfo, PendingWelcome, PendingCryptoEviction | Oban | advisory lock contention, CAS epoch races, idempotency conflicts, eviction FSM integrity |
| Chat & Messaging | chat.ex, message.ex, attachment.ex, dm_conversation.ex, dm_participant.ex, reaction.ex, pinned_message.ex, file_storage.ex, message_controller.ex, conversation_controller.ex, attachment_controller.ex, chat_channel.ex, dm_channel.ex, channel_helpers.ex | Message, Attachment, DmConversation, Reaction | FileStorage (local FS) | message scope XOR, attachment orphans, read position consistency, blob dedup integrity |
| Servers & Permissions | servers.ex, server.ex, channel.ex, role.ex, permissions.ex, permissions_cache.ex, member_cache.ex, membership.ex, member_role.ex, channel_*_permission.ex, invite.ex, server_ban.ex, audit_log.ex, emoji.ex, server_controller.ex, channel_controller.ex, emoji_controller.ex | Server, Channel, Role, Permissions, Invite, ServerBan | ETS caches, PubSub | permission cache staleness, admin bypass, channel override precedence, invite abuse |
| Voice & WebRTC | voice.ex, voice/room.ex, voice/room_supervisor.ex, voice_controller.ex, voice_channel.ex | Voice.Room GenServer, PeerConnection | ExWebRTC | max participant limits, idle timeout, SDP injection, heap memory limits, SFU routing |
| Sync & Runtime | sync.ex, sync_cursor.ex, runtime.ex, room.ex, room_event.ex, room_relation.ex, room_state_event.ex, sync_controller.ex, scope_sync_controller.ex, urgent_sync_controller.ex, unread_controller.ex | Room, RoomEvent, UserSyncEvent, SyncCursor | PubSub | cursor decode edge cases, room_seq atomicity, sync event fan-out N+1 |
| Infrastructure | application.ex, endpoint.ex, router.ex, user_socket.ex, user_channel.ex, server_presence_channel.ex, scope_channel.ex, telemetry.ex, health_controller.ex, workers/*.ex | Application supervisor, Oban workers | Phoenix, Oban, ExWebRTC | CORS config, session signing, body size limits, worker scheduling |
| User Content | avatar_controller.ex, search_index_controller.ex, search_index_snapshot.ex | Avatar/Banner uploads, SearchIndexSnapshot | FileStorage | file type validation, size limits, CAS version conflicts |
