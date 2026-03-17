defmodule Vesper.UrgentSyncTest do
  use Vesper.DataCase, async: true

  import Phoenix.ConnTest
  import Plug.Conn

  alias Vesper.Chat
  alias Vesper.Chat.Message
  alias Vesper.Repo
  alias Vesper.Sync
  alias Vesper.SyncCursor
  alias VesperWeb.MessageController
  alias VesperWeb.UrgentSyncController

  setup do
    {:ok, conn: build_conn() |> put_req_header("accept", "application/json")}
  end

  test "urgent sync returns only urgent events after the provided cursor", %{conn: conn} do
    user = insert_user()
    peer = insert_user()

    Sync.append_urgent_events([
      %{
        user_id: user.id,
        scope_kind: "dm",
        scope_id: Ecto.UUID.generate(),
        payload: %{message_id: "older-message", sender_id: peer.id}
      }
    ])

    cursor =
      SyncCursor.encode(%{
        synced_at: DateTime.utc_now() |> DateTime.truncate(:second),
        user_sync_event_id: Sync.latest_event_id_for_user(user.id)
      })

    Sync.append_user_event(user.id, "server", %{server_id: Ecto.UUID.generate()})

    Sync.append_urgent_events([
      %{
        user_id: user.id,
        scope_kind: "dm",
        scope_id: Ecto.UUID.generate(),
        payload: %{message_id: "newer-message", sender_id: peer.id}
      }
    ])

    response =
      conn
      |> assign(:current_user, user)
      |> UrgentSyncController.index(%{"since" => cursor, "limit" => "10"})
      |> json_response(200)

    assert get_in(response, ["events"]) |> Enum.map(& &1["payload"]["message_id"]) == [
             "newer-message"
           ]

    assert is_binary(response["token"])
  end

  test "message batch keeps request order and omits inaccessible messages", %{conn: conn} do
    user = insert_user()
    peer = insert_user()
    outsider = insert_user()

    {:ok, server} = Vesper.Servers.create_server(user, %{name: "alpha"})
    {:ok, hidden_server} = Vesper.Servers.create_server(outsider, %{name: "hidden"})
    {:ok, conversation} = Chat.create_conversation(user.id, [peer.id])

    channel = Enum.find(server.channels, &(&1.type == "text"))
    hidden_channel = Enum.find(hidden_server.channels, &(&1.type == "text"))

    dm_message = insert_dm_message(user.id, conversation.id, "dm body")
    inaccessible_message = insert_channel_message(outsider.id, hidden_channel.id, "hidden body")
    channel_message = insert_channel_message(user.id, channel.id, "channel body")

    response =
      conn
      |> assign(:current_user, user)
      |> MessageController.batch(%{
        "ids" => "#{dm_message.id},#{inaccessible_message.id},#{channel_message.id}"
      })
      |> json_response(200)

    assert Enum.map(response["messages"], & &1["id"]) == [dm_message.id, channel_message.id]
    assert Enum.map(response["messages"], & &1["content"]) == ["dm body", "channel body"]
  end

  defp insert_dm_message(sender_id, conversation_id, content) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    Repo.insert!(%Message{
      id: Ecto.UUID.generate(),
      content: content,
      ciphertext: nil,
      mls_epoch: nil,
      sender_id: sender_id,
      conversation_id: conversation_id,
      inserted_at: now,
      updated_at: now
    })
  end

  defp insert_channel_message(sender_id, channel_id, content) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    Repo.insert!(%Message{
      id: Ecto.UUID.generate(),
      content: content,
      ciphertext: nil,
      mls_epoch: nil,
      sender_id: sender_id,
      channel_id: channel_id,
      inserted_at: now,
      updated_at: now
    })
  end
end
