defmodule VesperWeb.MlsChannelTest do
  use Vesper.ChannelCase, async: false

  import Ecto.Query

  alias Vesper.Chat
  alias Vesper.Encryption
  alias Vesper.Encryption.MlsEvent
  alias Vesper.Repo
  alias Vesper.Servers

  describe "chat MLS control plane" do
    test "stores and replies for mls_request_join_all" do
      user = insert_user()
      {:ok, server} = Servers.create_server(user, %{name: "chat server"})
      channel = Enum.find(server.channels, &(&1.type == "text"))

      socket = connect_user_socket(user, "chat-client")
      {:ok, _reply, socket} = subscribe_and_join(socket, "chat:channel:#{channel.id}")

      ref = push(socket, "mls_request_join_all", %{})
      assert_reply ref, :ok, %{seq: seq} when is_integer(seq)

      stored = Repo.get_by!(MlsEvent, group_id: channel.id, event_type: "mls_request_join_all")

      assert stored.id == seq
      assert stored.sender_id == user.id
      assert stored.payload["user_id"] == user.id
    end

    test "returns replies for remove and welcome success paths" do
      user = insert_user()
      recipient = insert_user()
      {:ok, server} = Servers.create_server(user, %{name: "chat server"})
      channel = Enum.find(server.channels, &(&1.type == "text"))

      socket = connect_user_socket(user, "chat-client")
      {:ok, _reply, socket} = subscribe_and_join(socket, "chat:channel:#{channel.id}")

      remove_ref =
        push(socket, "mls_remove", %{
          "removed_user_id" => recipient.id,
          "commit_data" => "remove-commit",
          "idempotency_key" => "chat-remove-1"
        })

      assert_reply remove_ref, :ok, %{seq: remove_seq} when is_integer(remove_seq)

      remove_event =
        Repo.get_by!(MlsEvent,
          group_id: channel.id,
          event_type: "mls_remove",
          sender_id: user.id
        )

      assert remove_event.id == remove_seq
      assert remove_event.payload["removed_user_id"] == recipient.id

      welcome_ref =
        push(socket, "mls_welcome", %{
          "recipient_id" => recipient.id,
          "welcome_data" => Base.encode64(<<1, 2, 3>>),
          "recipient_device_id" => "device-a",
          "key_package_ref" => "kp-ref",
          "idempotency_key" => "chat-welcome-1"
        })

      assert_reply welcome_ref, :ok, %{id: welcome_id} when is_binary(welcome_id)

      welcome = Encryption.get_pending_welcome(welcome_id)
      assert welcome.recipient_id == recipient.id
      assert welcome.recipient_client_id == "device-a"
    end

    test "deduplicates remove and Welcome controls without repeating mutation" do
      user = insert_user()
      recipient = insert_user()
      {:ok, server} = Servers.create_server(user, %{name: "idempotent chat server"})
      channel = Enum.find(server.channels, &(&1.type == "text"))

      socket = connect_user_socket(user, "idempotent-chat-client")
      {:ok, _reply, socket} = subscribe_and_join(socket, "chat:channel:#{channel.id}")

      remove_payload = %{
        "removed_user_id" => recipient.id,
        "commit_data" => "remove-commit",
        "idempotency_key" => "chat-remove-dedup"
      }

      first_remove = push(socket, "mls_remove", remove_payload)
      assert_reply first_remove, :ok, %{seq: remove_seq}

      duplicate_remove = push(socket, "mls_remove", remove_payload)
      assert_reply duplicate_remove, :ok, %{seq: ^remove_seq}

      conflicting_remove =
        push(socket, "mls_remove", %{remove_payload | "commit_data" => "different-commit"})

      assert_reply conflicting_remove, :error, %{reason: "idempotency_conflict"}

      assert Repo.aggregate(
               from(event in MlsEvent,
                 where:
                   event.group_id == ^channel.id and
                     event.event_type == "mls_remove" and
                     event.sender_id == ^user.id
               ),
               :count
             ) == 1

      welcome_payload = %{
        "recipient_id" => recipient.id,
        "welcome_data" => Base.encode64(<<1, 2, 3>>),
        "recipient_device_id" => "device-dedup",
        "key_package_ref" => "kp-dedup",
        "idempotency_key" => "chat-welcome-dedup"
      }

      first_welcome = push(socket, "mls_welcome", welcome_payload)
      assert_reply first_welcome, :ok, %{id: welcome_id}

      duplicate_welcome = push(socket, "mls_welcome", welcome_payload)
      assert_reply duplicate_welcome, :ok, %{id: ^welcome_id}

      conflicting_welcome =
        push(socket, "mls_welcome", %{
          welcome_payload
          | "welcome_data" => Base.encode64(<<9, 9, 9>>)
        })

      assert_reply conflicting_welcome, :error, %{reason: "idempotency_conflict"}
      assert Encryption.get_pending_welcome(welcome_id).welcome_data == <<1, 2, 3>>
    end

    test "replays the newest join_all events, not the oldest" do
      joiner = insert_user()
      {:ok, server} = Servers.create_server(joiner, %{name: "chat server"})
      channel = Enum.find(server.channels, &(&1.type == "text"))

      sender_ids =
        for idx <- 1..51 do
          sender = insert_user(%{username: "chat_sender_#{idx}"})
          {:ok, _server} = Servers.join_server(sender, server.invite_code)

          assert {:ok, _event} =
                   Encryption.store_mls_event(%{
                     group_id: channel.id,
                     channel_id: channel.id,
                     event_type: "mls_request_join_all",
                     payload: %{user_id: sender.id},
                     sender_id: sender.id,
                     sender_device_id: "device-#{idx}"
                   })

          sender.id
        end

      socket = connect_user_socket(joiner, "chat-client")
      {:ok, _reply, _socket} = subscribe_and_join(socket, "chat:channel:#{channel.id}")

      replayed_sender_ids =
        for _ <- 1..50 do
          assert_push "mls_request_join_all", %{user_id: sender_id}
          sender_id
        end

      assert length(replayed_sender_ids) == 50
      assert List.last(sender_ids) in replayed_sender_ids
      refute List.first(sender_ids) in replayed_sender_ids
    end
  end

  describe "dm MLS control plane" do
    test "stores and replies for mls_request_join_all" do
      owner = insert_user()
      peer = insert_user()
      {:ok, conversation} = Chat.create_conversation(owner.id, [peer.id])

      socket = connect_user_socket(owner, "dm-client")
      {:ok, _reply, socket} = subscribe_and_join(socket, "dm:#{conversation.id}")

      ref = push(socket, "mls_request_join_all", %{})
      assert_reply ref, :ok, %{seq: seq} when is_integer(seq)

      stored =
        Repo.get_by!(MlsEvent, group_id: conversation.id, event_type: "mls_request_join_all")

      assert stored.id == seq
      assert stored.sender_id == owner.id
      assert stored.payload["user_id"] == owner.id
    end
  end

  describe "voice MLS control plane" do
    test "stores, replies, and replays join_all events after join" do
      owner = insert_user()
      peer = insert_user()
      {:ok, server} = Servers.create_server(owner, %{name: "voice server"})
      voice_channel = Enum.find(server.channels, &(&1.type == "voice"))

      sender_ids =
        for idx <- 1..51 do
          sender = insert_user(%{username: "voice_sender_#{idx}"})
          {:ok, _server} = Servers.join_server(sender, server.invite_code)

          assert {:ok, _event} =
                   Encryption.store_mls_event(%{
                     group_id: "voice:channel:#{voice_channel.id}",
                     channel_id: voice_channel.id,
                     event_type: "mls_request_join_all",
                     payload: %{user_id: sender.id},
                     sender_id: sender.id,
                     sender_device_id: "device-#{idx}"
                   })

          sender.id
        end

      socket = connect_user_socket(owner, "voice-client")
      {:ok, _reply, socket} = subscribe_and_join(socket, "voice:channel:#{voice_channel.id}")

      assert_push "offer", %{}
      assert_push "voice_state_update", %{participants: _participants}

      replayed_sender_ids =
        for _ <- 1..50 do
          assert_push "mls_request_join_all", %{user_id: sender_id}
          sender_id
        end

      assert length(replayed_sender_ids) == 50
      assert List.last(sender_ids) in replayed_sender_ids
      refute List.first(sender_ids) in replayed_sender_ids

      join_ref = push(socket, "mls_request_join_all", %{})
      assert_reply join_ref, :ok, %{seq: join_seq} when is_integer(join_seq)

      join_event =
        Repo.get_by!(MlsEvent,
          group_id: "voice:channel:#{voice_channel.id}",
          event_type: "mls_request_join_all",
          sender_id: owner.id
        )

      assert join_event.id == join_seq

      commit_payload = %{"commit_data" => "commit-bytes", "idempotency_key" => "voice-commit-1"}

      commit_ref = push(socket, "mls_commit", commit_payload)
      assert_reply commit_ref, :ok, %{seq: commit_seq} when is_integer(commit_seq)

      replay_commit_ref = push(socket, "mls_commit", commit_payload)

      assert_reply replay_commit_ref,
                   :ok,
                   %{seq: replay_commit_seq} when is_integer(replay_commit_seq)

      assert replay_commit_seq == commit_seq

      conflict_ref =
        push(socket, "mls_commit", %{
          "commit_data" => "different-commit-bytes",
          "idempotency_key" => "voice-commit-1"
        })

      assert_reply conflict_ref, :error, %{reason: "could not store commit"}

      commit_event =
        Repo.get_by!(MlsEvent,
          group_id: "voice:channel:#{voice_channel.id}",
          event_type: "mls_commit",
          sender_id: owner.id
        )

      assert commit_event.id == commit_seq
      assert commit_event.payload["commit_data"] == "commit-bytes"
      assert commit_event.idempotency_key == "voice-commit-1"

      assert length(
               Repo.all(
                 from(e in MlsEvent,
                   where:
                     e.group_id == ^"voice:channel:#{voice_channel.id}" and
                       e.event_type == "mls_commit" and
                       e.sender_id == ^owner.id
                 )
               )
             ) == 1

      remove_ref =
        push(socket, "mls_remove", %{
          "removed_user_id" => peer.id,
          "commit_data" => "remove-commit",
          "idempotency_key" => "voice-remove-1"
        })

      assert_reply remove_ref, :ok, %{seq: remove_seq} when is_integer(remove_seq)

      remove_event =
        Repo.get_by!(MlsEvent,
          group_id: "voice:channel:#{voice_channel.id}",
          event_type: "mls_remove",
          sender_id: owner.id
        )

      assert remove_event.id == remove_seq
      assert remove_event.payload["removed_user_id"] == peer.id

      welcome_ref =
        push(socket, "mls_welcome", %{
          "recipient_id" => peer.id,
          "welcome_data" => Base.encode64(<<4, 5, 6>>),
          "recipient_device_id" => "voice-device-a",
          "key_package_ref" => "voice-kp",
          "idempotency_key" => "voice-welcome-1"
        })

      assert_reply welcome_ref, :ok, %{id: welcome_id} when is_binary(welcome_id)

      welcome = Encryption.get_pending_welcome(welcome_id)
      assert welcome.recipient_id == peer.id
      assert welcome.recipient_client_id == "voice-device-a"
    end
  end
end
