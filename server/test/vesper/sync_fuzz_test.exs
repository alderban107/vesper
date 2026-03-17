defmodule Vesper.SyncFuzzTest do
  use Vesper.DataCase, async: true

  import Phoenix.ConnTest
  import Plug.Conn

  alias Vesper.Chat
  alias Vesper.Chat.Message
  alias Vesper.Repo
  alias Vesper.Runtime
  alias Vesper.Sync
  alias VesperWeb.ScopeSyncController

  @seed_count 12
  @ops_per_seed 80
  @scope_limit 50
  @event_limit max(@scope_limit * 4, 100)

  test "randomized room activity keeps user sync and scope sync coherent" do
    Enum.each(1..@seed_count, fn seed ->
      run_seed(seed)
    end)
  end

  defp run_seed(seed) do
    :rand.seed(:exsplus, {seed, seed * 17 + 3, seed * 31 + 7})

    user = insert_user(%{username: "sync_fuzz_user_#{seed}"})
    peer = insert_user(%{username: "sync_fuzz_peer_#{seed}"})
    alt_peer = insert_user(%{username: "sync_fuzz_peer_alt_#{seed}"})

    {:ok, server} = Vesper.Servers.create_server(user, %{name: "sync_fuzz_server_#{seed}"})
    default_channel = Enum.find(server.channels, &(&1.type == "text"))

    extra_channels =
      for idx <- 1..2 do
        channel =
          insert_channel(server, %{name: "sync_fuzz_channel_#{seed}_#{idx}", position: idx + 1})

        {:ok, _room} = Runtime.ensure_room_for_channel(channel)
        channel
      end

    channels = [default_channel | extra_channels]

    {:ok, dm_one} = Chat.create_conversation(user.id, [peer.id], name: "sync_fuzz_dm_#{seed}_1")

    {:ok, dm_two} =
      Chat.create_conversation(user.id, [alt_peer.id], name: "sync_fuzz_dm_#{seed}_2")

    conversations = [dm_one, dm_two]

    baseline_event_id = Sync.latest_event_id_for_user(user.id) || 0

    state =
      Enum.reduce(1..@ops_per_seed, initial_state(), fn step, state ->
        apply_random_op(state, step, user.id, peer.id, channels, conversations)
      end)

    changes = Sync.list_scope_changes_since(user.id, baseline_event_id)

    assert MapSet.new(changes.channel_ids) == state.changed_channels
    assert MapSet.new(changes.conversation_ids) == state.changed_conversations
    assert MapSet.new(changes.read_changes) == state.read_changes

    scope_requests =
      channels
      |> Enum.map(fn channel ->
        room = Runtime.get_room_for_channel(channel.id)
        after_seq = random_after_seq(room)

        %{
          "kind" => "channel",
          "id" => channel.id,
          "after_seq" => after_seq
        }
      end)
      |> Kernel.++(
        Enum.map(conversations, fn conversation ->
          room = Runtime.get_room_for_conversation(conversation.id)
          after_seq = random_after_seq(room)

          %{
            "kind" => "dm",
            "id" => conversation.id,
            "after_seq" => after_seq
          }
        end)
      )

    response =
      build_conn()
      |> put_req_header("accept", "application/json")
      |> assign(:current_user, user)
      |> ScopeSyncController.create(%{
        "limit" => Integer.to_string(@scope_limit),
        "scopes" => scope_requests
      })
      |> json_response(200)

    assert is_binary(response["token"])

    scope_request_map =
      Map.new(scope_requests, fn scope ->
        {{scope["kind"], scope["id"]}, scope["after_seq"]}
      end)

    assert length(response["scopes"]) == length(scope_requests)

    Enum.each(response["scopes"], fn batch ->
      kind = batch["kind"]
      scope_id = batch["scope_id"]
      after_seq = Map.fetch!(scope_request_map, {kind, scope_id})

      expected_messages =
        case kind do
          "channel" ->
            Chat.list_channel_messages_after_seq(scope_id, after_seq, limit: @scope_limit)

          "dm" ->
            Chat.list_conversation_messages_after_seq(scope_id, after_seq, limit: @scope_limit)
        end

      expected_events =
        Runtime.list_scope_events_after_seq(kind, scope_id, after_seq, limit: @event_limit)

      returned_message_ids = Enum.map(batch["messages"], & &1["id"])
      returned_event_ids = Enum.map(batch["events"], & &1["id"])

      assert returned_message_ids == Enum.map(expected_messages, & &1.id)
      assert returned_event_ids == Enum.map(expected_events, & &1.id)

      message_room_seqs = Enum.map(batch["messages"], & &1["room_seq"])
      event_room_seqs = Enum.map(batch["events"], & &1["room_seq"])

      assert message_room_seqs == Enum.sort(message_room_seqs)
      assert event_room_seqs == Enum.sort(event_room_seqs)
      assert length(message_room_seqs) == length(Enum.uniq(message_room_seqs))
      assert length(event_room_seqs) == length(Enum.uniq(event_room_seqs))
      assert Enum.all?(message_room_seqs, &(&1 > after_seq))
      assert Enum.all?(event_room_seqs, &(&1 > after_seq))
    end)
  end

  defp initial_state do
    %{
      changed_channels: MapSet.new(),
      changed_conversations: MapSet.new(),
      read_changes: MapSet.new()
    }
  end

  defp apply_random_op(state, step, user_id, peer_id, channels, conversations) do
    case :rand.uniform(6) do
      1 ->
        channel = Enum.at(channels, :rand.uniform(length(channels)) - 1)
        message = insert_encrypted_message(%{channel_id: channel.id, sender_id: user_id}, step)
        assert {:ok, _projected} = Runtime.project_message(message)

        %{
          state
          | changed_channels: MapSet.put(state.changed_channels, channel.id)
        }

      2 ->
        conversation = Enum.at(conversations, :rand.uniform(length(conversations)) - 1)
        sender_id = if(rem(step, 2) == 0, do: user_id, else: peer_id)

        message =
          insert_encrypted_message(
            %{conversation_id: conversation.id, sender_id: sender_id},
            step
          )

        assert {:ok, _projected} = Runtime.project_message(message)

        %{
          state
          | changed_conversations: MapSet.put(state.changed_conversations, conversation.id)
        }

      3 ->
        channel = Enum.at(channels, :rand.uniform(length(channels)) - 1)

        assert {:ok, _event} =
                 Runtime.append_scope_event(
                   "channel",
                   channel.id,
                   user_id,
                   random_mutation_type(),
                   %{message_id: Ecto.UUID.generate(), op: step}
                 )

        %{state | changed_channels: MapSet.put(state.changed_channels, channel.id)}

      4 ->
        conversation = Enum.at(conversations, :rand.uniform(length(conversations)) - 1)

        assert {:ok, _event} =
                 Runtime.append_scope_event(
                   "dm",
                   conversation.id,
                   user_id,
                   random_mutation_type(),
                   %{message_id: Ecto.UUID.generate(), op: step}
                 )

        %{state | changed_conversations: MapSet.put(state.changed_conversations, conversation.id)}

      5 ->
        channel = Enum.at(channels, :rand.uniform(length(channels)) - 1)

        case Chat.get_latest_channel_message(channel.id) do
          nil ->
            state

          message ->
            assert {:ok, _} = Chat.mark_channel_read(user_id, channel.id, message.id)

            %{state | read_changes: MapSet.put(state.read_changes, {:channel, channel.id})}
        end

      6 ->
        conversation = Enum.at(conversations, :rand.uniform(length(conversations)) - 1)

        case Chat.get_latest_conversation_message(conversation.id) do
          nil ->
            state

          message ->
            assert {:ok, _} = Chat.mark_dm_read(user_id, conversation.id, message.id)

            %{state | read_changes: MapSet.put(state.read_changes, {:dm, conversation.id})}
        end
    end
  end

  defp random_mutation_type do
    Enum.at(["reaction_update", "message_edited", "message_deleted"], :rand.uniform(3) - 1)
  end

  defp random_after_seq(nil), do: 0

  defp random_after_seq(room) do
    current_seq = room.current_seq || 0

    if current_seq <= 1 do
      0
    else
      :rand.uniform(current_seq) - 1
    end
  end

  defp insert_encrypted_message(attrs, step) do
    now = DateTime.utc_now() |> DateTime.add(step, :second) |> DateTime.truncate(:second)

    Repo.insert!(%Message{
      id: Ecto.UUID.generate(),
      channel_id: Map.get(attrs, :channel_id),
      conversation_id: Map.get(attrs, :conversation_id),
      sender_id: Map.fetch!(attrs, :sender_id),
      content: nil,
      ciphertext: <<"sync-fuzz-", step::integer-signed-32>>,
      mls_epoch: rem(step, 5),
      inserted_at: now,
      updated_at: now
    })
  end
end
