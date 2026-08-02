defmodule Vesper.UrgentSyncTest do
  use Vesper.DataCase, async: true

  import Phoenix.ConnTest
  import Plug.Conn

  alias Vesper.Accounts
  alias Vesper.Chat
  alias Vesper.Encryption
  alias Vesper.Chat.Message
  alias Vesper.Repo
  alias Vesper.Runtime
  alias Vesper.Sync
  alias Vesper.SyncCursor
  alias VesperWeb.ChannelController
  alias VesperWeb.ConversationController
  alias VesperWeb.MlsEventController
  alias VesperWeb.MessageController
  alias VesperWeb.ScopeSyncController
  alias VesperWeb.ScopeSummary
  alias VesperWeb.SyncController
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

  test "read changes remain targeted to the account that changed them" do
    user = insert_user()
    peer = insert_user()
    conversation_id = Ecto.UUID.generate()

    Sync.append_user_scope_event(user.id, "read", "dm", conversation_id)

    assert Sync.list_scope_changes_with_cursors(user.id, 0, 0).read_changes == [
             {:dm, conversation_id}
           ]

    assert Sync.list_scope_changes_with_cursors(peer.id, 0, 0).read_changes == []
    assert Sync.list_scope_changes_since(user.id, 0, [conversation_id]).read_changes == []
  end

  test "urgent sync drains a backlog without advancing past unreturned events", %{conn: conn} do
    user = insert_user()
    peer = insert_user()

    Sync.append_user_event(user.id, "cursor_baseline")

    cursor =
      SyncCursor.encode(%{
        synced_at: DateTime.utc_now() |> DateTime.truncate(:second),
        user_sync_event_id: Sync.latest_event_id_for_user(user.id)
      })

    for index <- 1..125 do
      Sync.append_urgent_events([
        %{
          user_id: user.id,
          scope_kind: "dm",
          scope_id: Ecto.UUID.generate(),
          payload: %{message_id: "message-#{index}", sender_id: peer.id}
        }
      ])
    end

    first =
      conn
      |> assign(:current_user, user)
      |> UrgentSyncController.index(%{"since" => cursor, "limit" => "100"})
      |> json_response(200)

    assert first["has_more"]
    assert length(first["events"]) == 100

    first_cursor = SyncCursor.decode(first["token"])
    assert first_cursor.user_sync_event_id == List.last(first["events"])["id"]
    assert is_integer(first_cursor.user_sync_high_water)

    Sync.append_urgent_events([
      %{
        user_id: user.id,
        scope_kind: "dm",
        scope_id: Ecto.UUID.generate(),
        payload: %{message_id: "after-high-water", sender_id: peer.id}
      }
    ])

    second =
      build_conn()
      |> put_req_header("accept", "application/json")
      |> assign(:current_user, user)
      |> UrgentSyncController.index(%{"since" => first["token"], "limit" => "100"})
      |> json_response(200)

    refute second["has_more"]
    assert length(second["events"]) == 25

    assert Enum.map(first["events"] ++ second["events"], & &1["payload"]["message_id"]) ==
             Enum.map(1..125, &"message-#{&1}")

    third =
      build_conn()
      |> put_req_header("accept", "application/json")
      |> assign(:current_user, user)
      |> UrgentSyncController.index(%{"since" => second["token"], "limit" => "100"})
      |> json_response(200)

    assert Enum.map(third["events"], & &1["payload"]["message_id"]) == ["after-high-water"]
  end

  test "urgent sync marks cursors older than retained events for workspace rebuild", %{conn: conn} do
    user = insert_user()

    expired_cursor =
      SyncCursor.encode(%{
        synced_at: DateTime.add(DateTime.utc_now(), -8 * 86_400, :second),
        user_sync_event_id: 0
      })

    response =
      conn
      |> assign(:current_user, user)
      |> UrgentSyncController.index(%{"since" => expired_cursor})
      |> json_response(200)

    assert response["cursor_expired"]
    assert response["events"] == []
    refute response["has_more"]
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

  test "scope sync returns a fresh token and room-seq deltas", %{conn: conn} do
    user = insert_user()
    {:ok, server} = Vesper.Servers.create_server(user, %{name: "alpha"})
    channel = Enum.find(server.channels, &(&1.type == "text"))

    message = insert_channel_message(user.id, channel.id, "hello")
    assert {:ok, projected_message} = Runtime.project_message(message)

    {:ok, mutation_event} =
      Runtime.append_scope_event("channel", channel.id, user.id, "message_edited", %{
        message_id: message.id
      })

    response =
      conn
      |> assign(:current_user, user)
      |> ScopeSyncController.create(%{
        "limit" => "20",
        "scopes" => [
          %{
            "kind" => "channel",
            "id" => channel.id,
            "after_seq" => Integer.to_string(projected_message.room_seq - 1)
          }
        ]
      })
      |> json_response(200)

    assert is_binary(response["token"])

    assert [%{"scope_id" => scope_id, "messages" => messages, "events" => events}] =
             response["scopes"]

    assert scope_id == channel.id
    assert Enum.map(messages, & &1["id"]) == [message.id]
    assert Enum.map(events, & &1["id"]) == [mutation_event.id]
  end

  test "scope restore stays bounded and older cursors backfill contiguously" do
    user = insert_user()
    {:ok, server} = Vesper.Servers.create_server(user, %{name: "bounded restore"})
    channel = Enum.find(server.channels, &(&1.type == "text"))

    for index <- 1..120 do
      message = insert_channel_message(user.id, channel.id, "history #{index}")
      assert {:ok, _event} = Runtime.project_message(message)
    end

    fetch_page = fn before ->
      scope = %{"kind" => "channel", "id" => channel.id}
      scope = if before, do: Map.put(scope, "before", before), else: scope

      response =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> assign(:current_user, user)
        |> ScopeSyncController.create(%{"limit" => "20", "scopes" => [scope]})
        |> json_response(200)

      [page] = response["scopes"]
      page
    end

    first = fetch_page.(nil)
    assert length(first["messages"]) == 20
    assert first["has_more"] == true
    assert is_binary(first["older_cursor"])
    assert first["latest_room_seq"] == 120

    pages =
      Stream.unfold(first, fn
        nil ->
          nil

        page ->
          next = if page["has_more"], do: fetch_page.(page["older_cursor"]), else: nil
          {page, next}
      end)
      |> Enum.to_list()

    messages = Enum.flat_map(pages, & &1["messages"])
    assert length(messages) == 120
    assert Enum.uniq_by(messages, & &1["id"]) |> length() == 120
    assert messages |> Enum.map(& &1["room_seq"]) |> Enum.sort() == Enum.to_list(1..120)
    assert List.last(pages)["has_more"] == false
    assert List.last(pages)["older_cursor"] == nil
  end

  test "full sync stays compact and server open loads channel activity", %{conn: conn} do
    user = insert_user()
    {:ok, server} = Vesper.Servers.create_server(user, %{name: "alpha"})
    channel = Enum.find(server.channels, &(&1.type == "text"))

    message = insert_channel_message(user.id, channel.id, "hello")
    assert {:ok, _projected_message} = Runtime.project_message(message)

    response =
      conn
      |> assign(:current_user, user)
      |> SyncController.index(%{})
      |> json_response(200)

    assert is_binary(response["token"])
    assert response["channel_activity"] == []

    server_summary = Enum.find(response["servers"], &(&1["id"] == server.id))
    refute Map.has_key?(server_summary, "channels")
    refute Map.has_key?(server_summary, "channels_loaded")

    channel_response =
      build_conn()
      |> put_req_header("accept", "application/json")
      |> assign(:current_user, user)
      |> ChannelController.index(%{"server_id" => server.id})
      |> json_response(200)

    channel_payload = Enum.find(channel_response["channels"], &(&1["id"] == channel.id))
    assert channel_payload["last_message_id"] == message.id
    assert channel_payload["last_message_sender"]["id"] == user.id
    assert Map.has_key?(channel_response["unread_counts"], channel.id)
  end

  test "workspace sync replaces a cursor older than event retention with a compact snapshot", %{
    conn: conn
  } do
    user = insert_user()
    {:ok, server} = Vesper.Servers.create_server(user, %{name: "retained state"})

    expired_cursor =
      SyncCursor.encode(%{
        synced_at: DateTime.add(DateTime.utc_now(), -8 * 86_400, :second),
        user_sync_event_id: 0,
        scope_sync_event_id: 0
      })

    response =
      conn
      |> assign(:current_user, user)
      |> SyncController.index(%{"since" => expired_cursor})
      |> json_response(200)

    assert response["full"]
    assert Enum.map(response["servers"], & &1["id"]) == [server.id]
    refute response["has_more"]
  end

  test "workspace sync and lazy channel loads do not expose hidden channels", %{conn: conn} do
    owner = insert_user()
    member = insert_user()
    {:ok, server} = Vesper.Servers.create_server(owner, %{name: "private"})
    assert {:ok, _membership} = Vesper.Servers.join_server(member, server.invite_code)
    channel = Enum.find(server.channels, &(&1.type == "text"))

    assert {:ok, _overrides} =
             Vesper.Servers.set_channel_permission_overrides(channel, %{
               users: [%{user_id: member.id, allow: [], deny: ["view_channel"]}]
             })

    baseline =
      conn
      |> assign(:current_user, member)
      |> SyncController.index(%{})
      |> json_response(200)

    Sync.append_scope_event("message", "channel", channel.id)

    delta =
      build_conn()
      |> put_req_header("accept", "application/json")
      |> assign(:current_user, member)
      |> SyncController.index(%{"since" => baseline["token"]})
      |> json_response(200)

    assert delta["channel_activity"] == []
    refute Map.has_key?(delta["unread_counts"]["channels"], channel.id)

    channel_response =
      build_conn()
      |> put_req_header("accept", "application/json")
      |> assign(:current_user, member)
      |> ChannelController.index(%{"server_id" => server.id})
      |> json_response(200)

    refute Enum.any?(channel_response["channels"], &(&1["id"] == channel.id))
    refute Map.has_key?(channel_response["unread_counts"], channel.id)
  end

  test "conversation pages preserve activity order and expose every conversation", %{conn: conn} do
    user = insert_user()

    conversations =
      for index <- 1..31 do
        peer = insert_user()
        {:ok, conversation} = Chat.create_conversation(user.id, [peer.id], name: "dm-#{index}")
        conversation
      end

    oldest = hd(conversations)
    message = insert_dm_message(user.id, oldest.id, "recent activity")
    assert {:ok, _projected_message} = Runtime.project_message(message)

    first =
      conn
      |> assign(:current_user, user)
      |> ConversationController.index(%{"limit" => "25"})
      |> json_response(200)

    assert hd(first["conversations"])["id"] == oldest.id
    assert first["has_more"]
    assert is_binary(first["next_cursor"])

    second =
      build_conn()
      |> put_req_header("accept", "application/json")
      |> assign(:current_user, user)
      |> ConversationController.index(%{
        "limit" => "25",
        "before" => first["next_cursor"]
      })
      |> json_response(200)

    refute second["has_more"]

    ids = Enum.map(first["conversations"] ++ second["conversations"], & &1["id"])
    assert length(ids) == 31
    assert length(Enum.uniq(ids)) == 31
    assert MapSet.new(ids) == MapSet.new(Enum.map(conversations, & &1.id))
  end

  test "workspace delta drains bounded authorized pages without skipping", %{conn: conn} do
    user = insert_user()
    peer = insert_user()
    outsider = insert_user()
    outsider_peer = insert_user()

    {:ok, conversation} = Chat.create_conversation(user.id, [peer.id], name: "visible")

    {:ok, hidden_conversation} =
      Chat.create_conversation(outsider.id, [outsider_peer.id], name: "hidden")

    baseline =
      conn
      |> assign(:current_user, user)
      |> SyncController.index(%{})
      |> json_response(200)

    for _ <- 1..125 do
      Sync.append_scope_event("message", "dm", conversation.id)
      Sync.append_scope_event("message", "dm", hidden_conversation.id)
    end

    {pages, final_token} =
      Enum.reduce_while(1..10, {[], baseline["token"]}, fn _, {pages, token} ->
        page =
          build_conn()
          |> put_req_header("accept", "application/json")
          |> assign(:current_user, user)
          |> SyncController.index(%{"since" => token, "limit" => "50"})
          |> json_response(200)

        next = {pages ++ [page], page["token"]}
        if page["has_more"], do: {:cont, next}, else: {:halt, next}
      end)

    assert length(pages) == 3
    assert Enum.map(pages, & &1["has_more"]) == [true, true, false]

    assert Enum.all?(pages, fn page ->
             Enum.map(page["conversations"], & &1["id"]) == [conversation.id]
           end)

    refute Enum.any?(pages, fn page ->
             Enum.any?(page["conversations"], &(&1["id"] == hidden_conversation.id))
           end)

    assert SyncCursor.decode(final_token).scope_sync_event_id == Sync.latest_scope_event_id()
  end

  test "scope summary updates broadcast channel activity over the user topic" do
    owner = insert_user()
    member = insert_user()
    {:ok, server} = Vesper.Servers.create_server(owner, %{name: "alpha"})
    assert {:ok, _joined_server} = Vesper.Servers.join_server(member, server.invite_code)

    channel = Enum.find(server.channels, &(&1.type == "text"))
    Phoenix.PubSub.subscribe(Vesper.PubSub, "user:#{owner.id}")
    Phoenix.PubSub.subscribe(Vesper.PubSub, "user:#{member.id}")

    message =
      insert_channel_message(owner.id, channel.id, "hello")
      |> then(fn message ->
        {:ok, event} = Runtime.project_message(message)
        Repo.preload(%{message | room_seq: event.room_seq}, :sender)
      end)

    assert :ok = ScopeSummary.broadcast_channel_update(channel.id, message, [owner.id, member.id])

    topics =
      for _ <- 1..2 do
        assert_receive %Phoenix.Socket.Broadcast{
          topic: topic,
          event: "scope_summary_updated",
          payload: %{
            kind: "channel",
            scope_id: scope_id,
            channel_activity: %{
              channel_id: activity_channel_id,
              message_id: message_id,
              sender_id: sender_id
            }
          }
        }

        assert scope_id == channel.id
        assert activity_channel_id == channel.id
        assert message_id == message.id
        assert sender_id == owner.id
        topic
      end

    assert Enum.sort(topics) == Enum.sort(["user:#{owner.id}", "user:#{member.id}"])
  end

  test "scope summary updates broadcast dm last-message resets over the user topic" do
    owner = insert_user()
    member = insert_user()
    {:ok, conversation} = Chat.create_conversation(owner.id, [member.id], name: "chat")

    Phoenix.PubSub.subscribe(Vesper.PubSub, "user:#{owner.id}")
    Phoenix.PubSub.subscribe(Vesper.PubSub, "user:#{member.id}")

    message =
      insert_dm_message(owner.id, conversation.id, "hello")
      |> then(fn message -> Repo.preload(message, :sender) end)

    assert :ok = ScopeSummary.broadcast_dm_update(conversation.id, message, [owner.id, member.id])

    topics =
      for _ <- 1..2 do
        assert_receive %Phoenix.Socket.Broadcast{
          topic: topic,
          event: "scope_summary_updated",
          payload: %{
            kind: "dm",
            scope_id: scope_id,
            conversation_reset: %{
              conversation_id: payload_conversation_id,
              last_message: %{
                id: message_id,
                conversation_id: message_conversation_id,
                sender_id: sender_id
              }
            }
          }
        }

        assert scope_id == conversation.id
        assert payload_conversation_id == conversation.id
        assert message_id == message.id
        assert message_conversation_id == conversation.id
        assert sender_id == owner.id
        topic
      end

    assert Enum.sort(topics) == Enum.sort(["user:#{owner.id}", "user:#{member.id}"])
  end

  test "scope sync preserves requested order for accessible scopes and skips hidden ones", %{
    conn: conn
  } do
    user = insert_user()
    peer = insert_user()
    outsider = insert_user()

    {:ok, server} = Vesper.Servers.create_server(user, %{name: "alpha"})
    {:ok, hidden_server} = Vesper.Servers.create_server(outsider, %{name: "hidden"})
    {:ok, conversation} = Chat.create_conversation(user.id, [peer.id], name: "chat")

    {:ok, hidden_conversation} =
      Chat.create_conversation(outsider.id, [peer.id], name: "hidden-chat")

    channel = Enum.find(server.channels, &(&1.type == "text"))
    hidden_channel = Enum.find(hidden_server.channels, &(&1.type == "text"))

    visible_channel_message = insert_channel_message(user.id, channel.id, "channel body")
    visible_dm_message = insert_dm_message(peer.id, conversation.id, "dm body")

    assert {:ok, _} = Runtime.project_message(visible_channel_message)
    assert {:ok, _} = Runtime.project_message(visible_dm_message)

    response =
      conn
      |> assign(:current_user, user)
      |> ScopeSyncController.create(%{
        "limit" => "20",
        "scopes" => [
          %{"kind" => "channel", "id" => hidden_channel.id, "after_seq" => "0"},
          %{"kind" => "dm", "id" => conversation.id, "after_seq" => "0"},
          %{"kind" => "channel", "id" => channel.id, "after_seq" => "0"},
          %{"kind" => "dm", "id" => hidden_conversation.id, "after_seq" => "0"}
        ]
      })
      |> json_response(200)

    assert Enum.map(response["scopes"], &{&1["kind"], &1["scope_id"]}) == [
             {"dm", conversation.id},
             {"channel", channel.id}
           ]

    assert Enum.at(response["scopes"], 0)["messages"] |> Enum.map(& &1["id"]) == [
             visible_dm_message.id
           ]

    assert Enum.at(response["scopes"], 1)["messages"] |> Enum.map(& &1["id"]) == [
             visible_channel_message.id
           ]
  end

  test "mls event replay returns durable events after the provided cursor", %{conn: conn} do
    user = insert_user()
    {:ok, server} = Vesper.Servers.create_server(user, %{name: "alpha"})
    channel = Enum.find(server.channels, &(&1.type == "text"))

    assert {:ok, first_event} =
             Vesper.Encryption.store_mls_event(%{
               group_id: channel.id,
               channel_id: channel.id,
               event_type: "mls_commit",
               payload: %{commit_data: "commit-1"},
               sender_id: user.id,
               sender_device_id: "device-a"
             })

    assert {:ok, second_event} =
             Vesper.Encryption.store_mls_event(%{
               group_id: channel.id,
               channel_id: channel.id,
               event_type: "mls_remove",
               payload: %{removed_user_id: user.id, commit_data: "commit-2"},
               sender_id: user.id,
               sender_device_id: "device-b"
             })

    response =
      conn
      |> assign(:current_user, user)
      |> assign(:current_device, %{client_id: "device-a"})
      |> MlsEventController.index(%{
        "channel_id" => channel.id,
        "after_seq" => Integer.to_string(first_event.id)
      })
      |> json_response(200)

    assert response["events"] == [
             %{
               "seq" => second_event.id,
               "event_type" => "mls_remove",
               "payload" => %{
                 "removed_user_id" => user.id,
                 "commit_data" => "commit-2"
               },
               "sender_id" => user.id,
               "sender_device_id" => "device-b",
               "inserted_at" => response["events"] |> hd() |> Map.fetch!("inserted_at")
             }
           ]
  end

  test "kick broadcasts a user-scoped membership revocation with affected groups" do
    owner = insert_user()
    member = insert_user()
    {:ok, server} = Vesper.Servers.create_server(owner, %{name: "alpha"})
    assert {:ok, _joined_server} = Vesper.Servers.join_server(member, server.invite_code)

    Phoenix.PubSub.subscribe(Vesper.PubSub, "user:#{member.id}")

    assert {:ok, _membership} =
             Vesper.Servers.kick_member(server.id, member.id, actor_id: owner.id)

    assert_receive %Phoenix.Socket.Broadcast{
      topic: topic,
      event: "server_membership_revoked",
      payload: %{
        server_id: server_id,
        channel_ids: channel_ids,
        reason: "kicked"
      }
    }

    assert topic == "user:#{member.id}"
    assert server_id == server.id
    assert Enum.sort(channel_ids) == Enum.sort(Enum.map(server.channels, & &1.id))
  end

  test "kick queues per-device crypto evictions for text channels and requests the first leaf" do
    owner = insert_user()
    member = insert_user()

    assert {:ok, _device} =
             Accounts.ensure_device(member, %{client_id: "member-a", name: "Member A"}, "trusted")

    assert {:ok, _device} =
             Accounts.ensure_device(member, %{client_id: "member-b", name: "Member B"}, "trusted")

    {:ok, server} = Vesper.Servers.create_server(owner, %{name: "alpha"})
    assert {:ok, _joined_server} = Vesper.Servers.join_server(member, server.invite_code)

    text_channels = Enum.filter(server.channels, &(&1.type == "text"))

    Enum.each(text_channels, fn channel ->
      Phoenix.PubSub.subscribe(Vesper.PubSub, "chat:channel:#{channel.id}")
    end)

    assert {:ok, _membership} =
             Vesper.Servers.kick_member(server.id, member.id, actor_id: owner.id)

    evictions =
      text_channels
      |> Enum.flat_map(fn channel ->
        Encryption.list_pending_crypto_evictions("channel", channel.id)
      end)

    assert length(evictions) == length(text_channels) * 2
    assert Enum.all?(evictions, &(&1.target_user_id == member.id))

    assert Enum.sort(Enum.map(evictions, & &1.target_device_id)) ==
             Enum.sort(
               for(
                 _channel <- text_channels,
                 device_id <- ["member-a", "member-b"],
                 do: device_id
               )
             )

    Enum.each(text_channels, fn channel ->
      assert_receive %Phoenix.Socket.Broadcast{
        topic: topic,
        event: "mls_eviction_request",
        payload: %{
          scope_id: scope_id,
          target_user_id: target_user_id,
          target_device_id: target_device_id
        }
      }

      assert topic == "chat:channel:#{channel.id}"
      assert scope_id == channel.id
      assert target_user_id == member.id
      assert target_device_id in ["member-a", "member-b"]
    end)
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
