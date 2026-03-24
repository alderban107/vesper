defmodule Vesper.QueryBenchmarkTest do
  @moduledoc """
  Counts total DB queries during a representative sync + message flow.
  Used as the metric for autoresearch DB query optimization.
  """
  use Vesper.DataCase, async: false

  alias Vesper.{Chat, Servers, Sync}

  @tag :benchmark
  test "counts total queries in sync + message scenario" do
    # Setup: 1 server, 2 channels, 3 users, 5 messages per channel
    user1 = insert_user(%{username: "bench_user1"})
    user2 = insert_user(%{username: "bench_user2"})
    user3 = insert_user(%{username: "bench_user3"})

    {:ok, server} = Servers.create_server(user1, %{"name" => "Benchmark Server"})
    channels = Servers.list_channels(server.id)
    channel = Enum.find(channels, &(&1.type == "text"))

    # user2 and user3 join the server
    {:ok, _} = Servers.join_server(user2, server.invite_code)
    {:ok, _} = Servers.join_server(user3, server.invite_code)

    # Create 5 messages per user in the channel
    for u <- [user1, user2, user3], i <- 1..5 do
      {:ok, _} =
        Chat.create_message(%{
          channel_id: channel.id,
          sender_id: u.id,
          ciphertext: :crypto.strong_rand_bytes(64),
          mls_epoch: 1,
          client_nonce: "nonce-#{u.id}-#{i}"
        })
    end

    # Create a DM conversation between user1 and user2
    {:ok, convo} = Chat.create_conversation(user1.id, [user2.id])

    for i <- 1..3 do
      {:ok, _} =
        Chat.create_message(%{
          conversation_id: convo.id,
          sender_id: user1.id,
          ciphertext: :crypto.strong_rand_bytes(64),
          mls_epoch: 1,
          client_nonce: "dm-nonce-#{i}"
        })
    end

    # Capture baseline scope event ID
    baseline = Sync.latest_scope_event_id() || 0

    # Now simulate a client sync flow and count queries
    counter = :counters.new(1, [:atomics])

    handler_id = "test-query-counter-#{System.unique_integer([:positive])}"

    :telemetry.attach(
      handler_id,
      [:vesper, :repo, :query],
      fn _event, _measurements, _metadata, _config ->
        :counters.add(counter, 1, 1)
      end,
      nil
    )

    # --- Measured operations ---

    # 1. List user's servers (skip emojis for sync — loaded on demand)
    _servers = Servers.list_user_servers(user1, include_emojis: false)

    # 2. List channels for server
    _channels = Servers.list_channels(server.id)

    # 3. Check permissions for user in server
    _perms = Servers.get_user_permissions(user1.id, server.id)

    # 4. List messages for channel (lean: initial sync, attachments load on demand)
    _messages = Chat.list_channel_messages(channel.id, limit: 20, lean: true)

    # 5. List conversations
    _convos = Chat.list_conversations(user1.id)

    # 6. List DM messages (lean: initial sync)
    _dm_msgs = Chat.list_conversation_messages(convo.id, limit: 20, lean: true)

    # 7. Get unread counts (combined — single UNION query)
    _unreads = Chat.get_all_unread_counts(user1.id, [channel.id], [convo.id])

    # 8. Scope changes since baseline
    scope_ids = [channel.id, convo.id, server.id]
    _changes = Sync.list_scope_changes_since(user1.id, baseline, scope_ids)

    # 9. Check membership
    _member = Servers.user_is_member?(user1.id, server.id)

    # --- End measured operations ---

    :telemetry.detach(handler_id)

    query_count = :counters.get(counter, 1)

    # Write metric to stdout for autoresearch to capture
    IO.puts("QUERY_COUNT:#{query_count}")

    # Soft assertion — we want this to be as low as possible
    assert query_count > 0
  end
end
