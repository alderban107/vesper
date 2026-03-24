This is a large refactor in progress. Saving state for the next session.

## What's Done
- Phase 1 (server schemas + infrastructure) is committed and working
- Phase 2 (SDK MLS routing) was partially implemented but needs the message broadcast path unified

## What Needs to Happen Next
The client needs to join `chat:channel:#{channelId}` for DMs with channel mappings, not `dm:#{conversationId}`. ALL traffic (messages + MLS) flows through the channel topic. This requires:

1. SDK: `EncryptedScope` gets `channelId` field
2. SDK: `ensureScopeReady` routes DMs with channelId through `ensureChannelGroupReady`
3. SDK: `channelRequiresExternalJoin` returns false for DM channels (no server)
4. SDK: `resolveChannelOwnerId` null → any member can create group
5. Client `joinDmChat`: join `chat:channel:#{channelId}` topic instead of `dm:#{conversationId}`
6. Client `sendDmMessage`: use channelId scope for encryption AND message push
7. Server `ChatChannel`: accept DM channel joins (already done)
8. Server: DmChannel becomes unused for new DMs

## Key Files Modified (server — committed)
- server/lib/vesper/servers/channel.ex — dm/group_dm types
- server/lib/vesper/servers/membership.ex — channel_id, archived_at
- server/lib/vesper/chat.ex — create_dm_channel, dual-write
- server/lib/vesper_web/channels/chat_channel.ex — accept DM joins
- server/lib/vesper/servers.ex — DM channel membership checks

## Key Files to Modify (client — not yet committed)
- sdk/src/client/encryptedChat.ts — MLS routing, EncryptedScope type
- sdk/src/api/chat.ts — VesperConversation.channel_id
- client/src/renderer/src/stores/messageStore.ts — joinDmChat uses channel topic
- client/src/renderer/src/stores/dmStore.ts — DmConversation.channel_id
- client/src/renderer/src/components/chat/MessageList.tsx — pass channelId
