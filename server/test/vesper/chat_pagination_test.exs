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
end
