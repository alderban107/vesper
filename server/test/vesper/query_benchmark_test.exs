defmodule Vesper.QueryBenchmarkTest do
  @moduledoc """
  Counts total DB queries during representative flows.
  Two scenarios measured:
  1. Full sync flow (login → list servers → list channels → messages → unreads)
  2. Hot path: 10 rapid message sends (the bottleneck at 1M scale)
  """
  use Vesper.DataCase, async: false

  alias Vesper.{Chat, Servers, Sync, Runtime}

  @tag :benchmark
  test "counts total queries in sync + hot message path" do
    # Setup: 1 server, 1 text channel, 3 users, seed messages
    user1 = insert_user(%{username: "bench_user1"})
    user2 = insert_user(%{username: "bench_user2"})
    user3 = insert_user(%{username: "bench_user3"})

    {:ok, server} = Servers.create_server(user1, %{"name" => "Benchmark Server"})
    channels = Servers.list_channels(server.id)
    channel = Enum.find(channels, &(&1.type == "text"))

    {:ok, _} = Servers.join_server(user2, server.invite_code)
    {:ok, _} = Servers.join_server(user3, server.invite_code)

    # Seed 5 messages
    for u <- [user1, user2], i <- 1..5 do
      {:ok, _} =
        Chat.create_message(%{
          channel_id: channel.id,
          sender_id: u.id,
          ciphertext: :crypto.strong_rand_bytes(64),
          mls_epoch: 1,
          client_nonce: "seed-#{u.id}-#{i}"
        })
    end

    {:ok, convo} = Chat.create_conversation(user1.id, [user2.id])

    for i <- 1..3 do
      {:ok, _} =
        Chat.create_message(%{
          conversation_id: convo.id,
          sender_id: user1.id,
          ciphertext: :crypto.strong_rand_bytes(64),
          mls_epoch: 1,
          client_nonce: "dm-seed-#{i}"
        })
    end

    baseline_scope = Sync.latest_scope_event_id() || 0

    # ============================================================
    # SCENARIO 1: Full sync flow
    # ============================================================
    sync_counter = :counters.new(1, [:atomics])
    sync_handler = "sync-counter-#{System.unique_integer([:positive])}"

    :telemetry.attach(
      sync_handler,
      [:vesper, :repo, :query],
      fn _, _, _, _ ->
        :counters.add(sync_counter, 1, 1)
      end,
      nil
    )

    _servers = Servers.list_user_servers(user1, include_emojis: false)
    _channels = Servers.list_channels(server.id)
    _perms = Servers.get_user_permissions(user1.id, server.id)
    _messages = Chat.list_channel_messages(channel.id, limit: 20, lean: true)
    _convos = Chat.list_conversations(user1.id)
    _dm_msgs = Chat.list_conversation_messages(convo.id, limit: 20, lean: true)
    _unreads = Chat.get_all_unread_counts(user1.id, [channel.id], [convo.id])

    _changes =
      Sync.list_scope_changes_since(user1.id, baseline_scope, [channel.id, convo.id, server.id])

    _member = Servers.user_is_member?(user1.id, server.id)

    :telemetry.detach(sync_handler)
    sync_queries = :counters.get(sync_counter, 1)

    # ============================================================
    # SCENARIO 2: Hot path — 10 message sends
    # ============================================================
    msg_counter = :counters.new(1, [:atomics])
    msg_handler = "msg-counter-#{System.unique_integer([:positive])}"

    :telemetry.attach(
      msg_handler,
      [:vesper, :repo, :query],
      fn _, _, _, _ ->
        :counters.add(msg_counter, 1, 1)
      end,
      nil
    )

    for i <- 1..10 do
      {:ok, _} =
        Chat.create_message(
          %{
            channel_id: channel.id,
            sender_id: user1.id,
            ciphertext: :crypto.strong_rand_bytes(64),
            mls_epoch: 1,
            client_nonce: "hot-#{i}"
          },
          preload: []
        )
    end

    :telemetry.detach(msg_handler)
    msg_queries = :counters.get(msg_counter, 1)

    total = sync_queries + msg_queries
    per_msg = div(msg_queries, 10)

    IO.puts("SYNC_QUERIES:#{sync_queries}")
    IO.puts("MSG_QUERIES:#{msg_queries}")
    IO.puts("PER_MSG:#{per_msg}")
    IO.puts("QUERY_COUNT:#{total}")

    assert sync_queries > 0
    assert msg_queries > 0
  end
end
