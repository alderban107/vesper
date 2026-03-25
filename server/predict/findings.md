# Predict Analysis — DM-as-Channels P1 Failures

**Date:** 2026-03-24
**Depth:** Deep (8 personas, 3 rounds, adversarial)
**Commit:** fix/mls-e2e-handshake

## Root Cause (Confirmed 8/8 personas)

**`chat_channel.ex` delivers DM messages but skips DM notification side effects.**

When DMs moved from `dm_channel.ex` → `chat_channel.ex`, message broadcast works,
but four notification side effects are absent for serverless (DM) channels:

| Side Effect | dm_channel.ex | chat_channel.ex (nil server_id) |
|---|---|---|
| `notify_dm_activity()` → user channels | line 102 | MISSING |
| `append_dm_urgent_events()` | line 77 | MISSING (uses channel variant) |
| `ScopeSummary` in dm_activity payload | line 876 | MISSING |
| `notify_scope_mutation()` per-user | line 89 | Partial (recent fix, wrong `kind`) |

## How this maps to each P1 failure

### F-1: DM unread badge (CRITICAL, 8/8 consensus)
- `unreadStore.incrementDm()` is ONLY called by `dm_activity` handler (presenceStore.ts:416)
- `chat_channel.ex` never sends `dm_activity` for DM channels
- No event → no badge → test fails at `.vesper-dm-unread-badge` selector
- **Location:** chat_channel.ex:104-131 (missing dm_activity broadcast)

### F-2: DM attachment upload timeout (HIGH, 7/8 consensus)
- Attachment sends successfully via channel topic
- But `dm_activity` never fires → sidebar shows "No messages yet"
- `sendAttachmentWithEncryptionRetry` gets confused by stale sidebar state
- Also: `startLiveScopeWatch` fire-and-forget race (secondary cause)
- **Location:** chat_channel.ex:104-131, messageStore.ts:703 (fire-and-forget)

### F-3: Channel unread badge (MEDIUM, 5/8 consensus)
- Pre-existing test timing issue, NOT caused by DM migration
- `scope_mutation` arrives but CSS selector timing is fragile
- **Location:** p1-typing-unread.spec.ts:118 (test-level issue)

### F-4-5: DM voice call (LOW, 8/8 consensus: pre-existing)
- Voice uses `voice:dm:` topic, independent of `chat:channel:` path
- voiceStore.ts:590 joins `voice:dm:${conversationId}` — no channel_id
- voice_channel.ex:41 checks `Chat.user_is_participant?` — no server_id needed
- Confirmed unrelated to migration
- **Location:** p1-voice.spec.ts (pre-existing infra issue)

## The Fix

### Primary: Add dm_activity to chat_channel.ex for DM channels

In `chat_channel.ex` `handle_in("new_message")`, after message creation,
when `server_id` is nil:

1. Look up the conversation_id from the channel's DmConversation link
2. Send `dm_activity` to each member's user channel (same as dm_channel.ex:869-888)
3. Call `append_dm_urgent_events` instead of `append_channel_urgent_events`

```elixir
# After Chat.create_message, when server_id is nil:
if is_nil(socket.assigns.server_id) do
  case Chat.get_conversation_for_channel(channel_id) do
    %{id: conversation_id, participants: participants} ->
      participant_ids = Enum.map(participants, & &1.user_id)
      notify_dm_activity(conversation_id, sender_id, participant_ids, sender_info, message)
      append_dm_urgent_events(message, sender_id, participant_ids)
    _ -> :ok
  end
end
```

### Secondary: Fix scope_mutation kind for DM channels

In the recent `notify_scope_mutation(nil, kind, scope_id, activity)` fix,
the `kind` is passed as `"channel"` but should be `"dm"` with the
conversation_id (not channel_id) as scope_id for client compatibility.

### Tertiary: Resolve fire-and-forget startLiveScopeWatch

Make `joinChannelChat` dedup by topic (skip if already watching).
This prevents the token invalidation → dispose → reconnect cycle.

## Verification

After fix:
- `mix test` — 92/92
- E2E p0-smoke — 19/19 (should remain 100%)
- E2E p1 DM unread — should now pass (dm_activity triggers badge)
- E2E p1 DM attachment — should now pass (sidebar updates correctly)
- E2E p1 channel unread — may still fail (pre-existing, unrelated)
- E2E p1 DM voice — will still fail (pre-existing, unrelated)
