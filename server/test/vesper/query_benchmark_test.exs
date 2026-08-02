defmodule Vesper.QueryBenchmarkTest do
  @moduledoc """
  Counts total DB queries during representative flows.
  Two scenarios measured:
  1. Full sync flow (login → list servers → list channels → messages → unreads)
  2. Hot path: 10 rapid message sends (the bottleneck at 1M scale)
  """
  use Vesper.DataCase, async: false

  import Ecto.Query

  alias Vesper.{Chat, Repo, Runtime, Servers, Sync}
  alias Vesper.Chat.Message
  alias Vesper.Runtime.{Room, RoomEvent}

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
            client_nonce: "hot-#{i}",
            disappearing_ttl: 0
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

  @tag :benchmark
  test "latest restore window keeps constant query count across 100x history growth" do
    user = insert_user(%{username: "restore_benchmark"})
    {:ok, server} = Servers.create_server(user, %{"name" => "Restore Benchmark"})
    channel = Enum.find(server.channels, &(&1.type == "text"))
    room = Runtime.get_room_for_channel(channel.id)

    seed_message_history(channel.id, room.id, user.id, 1..10)

    {small_queries, small_us, small_rows} =
      measure_queries(fn ->
        Chat.list_channel_messages(channel.id, limit: 20, lean: true)
      end)

    seed_message_history(channel.id, room.id, user.id, 11..1_010)

    Repo.update_all(from(entry in Room, where: entry.id == ^room.id),
      set: [current_seq: 1_010, last_message_seq: 1_010]
    )

    {large_queries, large_us, large_rows} =
      measure_queries(fn ->
        Chat.list_channel_messages(channel.id, limit: 20, lean: true)
      end)

    IO.puts("RESTORE_ROWS:10->1010")
    IO.puts("RESTORE_QUERIES:#{small_queries}->#{large_queries}")
    IO.puts("RESTORE_LATENCY_US:#{small_us}->#{large_us}")

    assert small_rows == 10
    assert large_rows == 20
    assert large_queries == small_queries
    assert large_queries <= 3
    assert large_us < 500_000
  end

  defp seed_message_history(channel_id, room_id, sender_id, range) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    messages =
      Enum.map(range, fn sequence ->
        %{
          id: Ecto.UUID.generate(),
          channel_id: channel_id,
          sender_id: sender_id,
          ciphertext: :crypto.strong_rand_bytes(32),
          mls_epoch: 1,
          is_reply: false,
          client_nonce: "restore-seed-#{sequence}",
          inserted_at: now,
          updated_at: now
        }
      end)

    Repo.insert_all(Message, messages)

    events =
      Enum.zip(messages, range)
      |> Enum.map(fn {message, sequence} ->
        %{
          id: Ecto.UUID.generate(),
          room_id: room_id,
          message_id: message.id,
          sender_id: sender_id,
          event_type: "message",
          room_seq: sequence,
          inserted_at: now,
          updated_at: now
        }
      end)

    Repo.insert_all(RoomEvent, events)
  end

  defp measure_queries(operation) do
    counter = :counters.new(1, [:atomics])
    handler = "restore-query-counter-#{System.unique_integer([:positive])}"

    :telemetry.attach(
      handler,
      [:vesper, :repo, :query],
      fn _, _, _, _ -> :counters.add(counter, 1, 1) end,
      nil
    )

    started = System.monotonic_time(:microsecond)
    rows = operation.()
    elapsed = System.monotonic_time(:microsecond) - started
    :telemetry.detach(handler)
    {:counters.get(counter, 1), elapsed, length(rows)}
  end
end
