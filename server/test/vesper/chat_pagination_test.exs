defmodule Vesper.ChatPaginationTest do
  use Vesper.DataCase, async: true

  import Ecto.Query

  alias Vesper.Chat
  alias Vesper.Repo
  alias Vesper.Runtime
  alias Vesper.Runtime.RoomEvent

  describe "message pagination cursors" do
    test "channel pagination keeps same-timestamp messages reachable" do
      user = insert_user()
      server = insert_server(user)
      channel = insert_channel(server)
      inserted_at = ~U[2026-03-16 12:00:00Z]

      oldest =
        insert_message(user, channel, %{
          id: "00000000-0000-0000-0000-000000000001",
          inserted_at: inserted_at
        })

      middle =
        insert_message(user, channel, %{
          id: "00000000-0000-0000-0000-000000000002",
          inserted_at: inserted_at
        })

      newest =
        insert_message(user, channel, %{
          id: "00000000-0000-0000-0000-000000000003",
          inserted_at: inserted_at
        })

      first_page = Chat.list_channel_messages(channel.id, limit: 2)

      assert Enum.map(first_page, & &1.id) == [newest.id, middle.id]

      before_cursor = "#{middle.inserted_at |> DateTime.to_iso8601()}|#{middle.id}"
      older_page = Chat.list_channel_messages(channel.id, limit: 2, before: before_cursor)

      assert Enum.map(older_page, & &1.id) == [oldest.id]

      after_cursor = "#{middle.inserted_at |> DateTime.to_iso8601()}|#{middle.id}"
      newer_page = Chat.list_channel_messages(channel.id, limit: 2, after: after_cursor)

      assert Enum.map(newer_page, & &1.id) == [newest.id]
    end
  end

  describe "unread counts" do
    test "channel unread counts use room sequence when messages share a timestamp" do
      owner = insert_user()
      reader = insert_user()
      server = insert_server(owner)
      channel = insert_channel(server)

      assert {:ok, _room} = Runtime.ensure_room_for_channel(channel)

      inserted_at = ~U[2026-03-16 12:00:00Z]

      first =
        insert_message(owner, channel, %{
          id: "00000000-0000-0000-0000-000000000101",
          inserted_at: inserted_at
        })

      second =
        insert_message(owner, channel, %{
          id: "00000000-0000-0000-0000-000000000102",
          inserted_at: inserted_at
        })

      assert {:ok, _} = Runtime.project_message(first)
      assert {:ok, _} = Runtime.project_message(second)
      assert {:ok, _} = Chat.mark_channel_read(reader.id, channel.id, first.id)

      assert Chat.get_channel_unread_counts(reader.id, [channel.id]) == %{channel.id => 1}
    end

    test "dm unread counts use room sequence when messages share a timestamp" do
      sender = insert_user()
      reader = insert_user()
      {:ok, conversation} = Chat.create_conversation(sender.id, [reader.id])

      inserted_at = ~U[2026-03-16 12:00:00Z]

      first =
        Repo.insert!(%Vesper.Chat.Message{
          id: "00000000-0000-0000-0000-000000000201",
          ciphertext: <<1>>,
          mls_epoch: 0,
          sender_id: sender.id,
          conversation_id: conversation.id,
          inserted_at: inserted_at,
          updated_at: inserted_at
        })

      second =
        Repo.insert!(%Vesper.Chat.Message{
          id: "00000000-0000-0000-0000-000000000202",
          ciphertext: <<2>>,
          mls_epoch: 0,
          sender_id: sender.id,
          conversation_id: conversation.id,
          inserted_at: inserted_at,
          updated_at: inserted_at
        })

      assert {:ok, _} = Runtime.project_message(first)
      assert {:ok, _} = Runtime.project_message(second)
      assert {:ok, _} = Chat.mark_dm_read(reader.id, conversation.id, first.id)

      assert Chat.get_dm_unread_counts(reader.id, [conversation.id]) == %{conversation.id => 1}
    end

    test "read changes stay visible to sync cursors within the same second" do
      user = insert_user()
      peer = insert_user()
      {:ok, conversation} = Chat.create_conversation(user.id, [peer.id])

      message =
        Repo.insert!(%Vesper.Chat.Message{
          id: "00000000-0000-0000-0000-000000000301",
          ciphertext: <<3>>,
          mls_epoch: 0,
          sender_id: peer.id,
          conversation_id: conversation.id,
          inserted_at: ~U[2026-03-16 12:00:00Z],
          updated_at: ~U[2026-03-16 12:00:00Z]
        })

      assert {:ok, _} = Runtime.project_message(message)

      since = capture_same_second_since()

      assert {:ok, _} = Chat.mark_dm_read(user.id, conversation.id, message.id)
      assert Chat.list_conversations_with_read_changes_since(user.id, since) == [conversation.id]
    end
  end

  describe "scope sync events" do
    test "lists mutation events for a scope in insertion order" do
      user = insert_user()
      peer = insert_user()
      {:ok, conversation} = Chat.create_conversation(user.id, [peer.id])
      older = ~U[2026-03-16 12:00:00Z]
      newer = ~U[2026-03-16 12:00:01Z]

      {:ok, first} =
        Runtime.append_scope_event("dm", conversation.id, user.id, "message_edited", %{
          message_id: "a"
        })

      {:ok, second} =
        Runtime.append_scope_event("dm", conversation.id, user.id, "message_deleted", %{
          message_id: "b"
        })

      Repo.update_all(
        from(e in RoomEvent, where: e.id == ^first.id),
        set: [inserted_at: older]
      )

      Repo.update_all(
        from(e in RoomEvent, where: e.id == ^second.id),
        set: [inserted_at: newer]
      )

      events = Runtime.list_scope_events("dm", conversation.id, older)

      assert Enum.map(events, & &1.id) == [second.id]
    end
  end

  describe "room sync summaries" do
    test "latest message summary updates on insert and delete" do
      user = insert_user()
      server = insert_server(user)
      channel = insert_channel(server)
      {:ok, _room} = Runtime.ensure_room_for_channel(channel)

      older =
        insert_message(user, channel, %{
          id: "00000000-0000-0000-0000-000000000010",
          inserted_at: ~U[2026-03-16 12:00:00Z]
        })

      newer =
        insert_message(user, channel, %{
          id: "00000000-0000-0000-0000-000000000011",
          inserted_at: ~U[2026-03-16 12:00:01Z]
        })

      assert {:ok, _event} = Runtime.project_message(older)
      assert {:ok, _event} = Runtime.project_message(newer)

      latest_before_delete = Chat.get_latest_channel_messages([channel.id])
      assert latest_before_delete[channel.id].id == newer.id

      assert {:ok, _message} = Chat.delete_message(newer)

      latest_after_delete = Chat.get_latest_channel_messages([channel.id])
      assert latest_after_delete[channel.id].id == older.id
    end

    test "mutation summary tracks the latest non-message scope event" do
      user = insert_user()
      peer = insert_user()
      {:ok, conversation} = Chat.create_conversation(user.id, [peer.id])
      older = ~U[2026-03-16 12:00:00Z]
      newer = ~U[2026-03-16 12:00:01Z]

      {:ok, first} =
        Runtime.append_scope_event("dm", conversation.id, user.id, "message_edited", %{
          message_id: "a"
        })

      {:ok, second} =
        Runtime.append_scope_event("dm", conversation.id, user.id, "message_deleted", %{
          message_id: "b"
        })

      Repo.update_all(
        from(e in RoomEvent, where: e.id == ^first.id),
        set: [inserted_at: older]
      )

      Repo.update_all(
        from(e in RoomEvent, where: e.id == ^second.id),
        set: [inserted_at: newer]
      )

      Repo.update_all(
        from(r in Runtime.Room, where: r.conversation_id == ^conversation.id),
        set: [last_mutation_at: newer]
      )

      assert Chat.list_changed_conversation_ids_since(user.id, older) == [conversation.id]
    end
  end

  defp capture_same_second_since do
    now = DateTime.utc_now()
    micros = elem(now.microsecond, 0)

    cond do
      micros > 850_000 ->
        Process.sleep(200)
        capture_same_second_since()

      micros < 100_000 ->
        Process.sleep(120)
        capture_same_second_since()

      true ->
        DateTime.add(now, -100_000, :microsecond)
    end
  end
end
