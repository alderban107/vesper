defmodule Vesper.HistoryAuthorizationTest do
  use Vesper.DataCase, async: false

  import Ecto.Query

  alias Vesper.Chat
  alias Vesper.Encryption
  alias Vesper.Repo
  alias Vesper.Runtime
  alias Vesper.Runtime.{Room, RoomEvent}
  alias Vesper.Servers
  alias VesperWeb.ControllerHelpers

  describe "application-tenure fences" do
    test "captures the current room sequence when a server member joins" do
      owner = insert_user()
      member = insert_user()
      {:ok, server} = Servers.create_server(owner, %{name: "History boundary"})
      channel = Enum.find(server.channels, &(&1.type == "text"))

      assert {:ok, before_join} =
               Runtime.append_scope_event(
                 "channel",
                 channel.id,
                 owner.id,
                 "test.before_join",
                 %{}
               )

      assert {:ok, _server} = Servers.join_server(member, server.invite_code)
      membership = Servers.get_membership(member.id, server.id)

      assert {:ok, after_join} =
               Runtime.append_scope_event(
                 "channel",
                 channel.id,
                 owner.id,
                 "test.after_join",
                 %{}
               )

      assert {:ok, authorization} =
               ControllerHelpers.authorize_history_scope(member.id, channel.id)

      assert authorization.authorization_generation == membership.id
      assert authorization.authorized_after_room_seq == before_join.room_seq
      assert after_join.room_seq > authorization.authorized_after_room_seq
    end

    test "a join waits for an in-flight room event before capturing its fence" do
      owner = insert_user()
      member = insert_user()
      {:ok, server} = Servers.create_server(owner, %{name: "Atomic history boundary"})
      channel = Enum.find(server.channels, &(&1.type == "text"))
      room = Runtime.get_room_for_channel(channel.id)
      parent = self()
      commit_ref = make_ref()

      event_task =
        Task.async(fn ->
          Ecto.Adapters.SQL.Sandbox.allow(Repo, parent, self())

          Repo.transaction(fn ->
            locked_room =
              Repo.one!(
                from(candidate in Room, where: candidate.id == ^room.id, lock: "FOR UPDATE")
              )

            next_seq = locked_room.current_seq + 1
            Repo.update!(Ecto.Changeset.change(locked_room, current_seq: next_seq))

            event =
              Repo.insert!(%RoomEvent{
                room_id: room.id,
                room_seq: next_seq,
                sender_id: owner.id,
                event_type: "test.in_flight_before_join",
                content: %{}
              })

            send(parent, {:event_allocated, event.room_seq})

            receive do
              {:commit_event, ^commit_ref} -> event
            end
          end)
        end)

      assert_receive {:event_allocated, event_seq}, 1_000

      join_task =
        Task.async(fn ->
          Ecto.Adapters.SQL.Sandbox.allow(Repo, parent, self())
          Servers.join_server(member, server.invite_code)
        end)

      assert Task.yield(join_task, 100) == nil
      send(event_task.pid, {:commit_event, commit_ref})
      assert {:ok, %{room_seq: ^event_seq}} = Task.await(event_task, 5_000)
      assert {:ok, _server} = Task.await(join_task, 5_000)

      assert {:ok, authorization} =
               ControllerHelpers.authorize_history_scope(member.id, channel.id)

      assert authorization.authorized_after_room_seq == event_seq
    end

    test "concurrent server joins and channel creation cannot omit a history grant" do
      owner = insert_user()
      {:ok, server} = Servers.create_server(owner, %{name: "Concurrent history grants"})
      parent = self()

      for index <- 1..8 do
        member = insert_user()

        join_task =
          Task.async(fn ->
            Ecto.Adapters.SQL.Sandbox.allow(Repo, parent, self())
            Servers.join_server(member, server.invite_code)
          end)

        channel_task =
          Task.async(fn ->
            Ecto.Adapters.SQL.Sandbox.allow(Repo, parent, self())
            Servers.create_channel(server.id, %{name: "grant-race-#{index}", type: "text"})
          end)

        assert {:ok, _server} = Task.await(join_task, 5_000)
        assert {:ok, channel} = Task.await(channel_task, 5_000)
        membership = Servers.get_membership(member.id, server.id)
        room = Runtime.get_room_for_channel(channel.id)
        authorization = Encryption.get_room_history_authorization(room.id, member.id)

        assert authorization.authorization_generation == membership.id
      end
    end

    test "a leave and rejoin creates a new generation and denies the away window" do
      owner = insert_user()
      member = insert_user()
      {:ok, server} = Servers.create_server(owner, %{name: "History rejoin"})
      channel = Enum.find(server.channels, &(&1.type == "text"))
      assert {:ok, _server} = Servers.join_server(member, server.invite_code)
      first_membership = Servers.get_membership(member.id, server.id)

      assert {:ok, _during_first_tenure} =
               Runtime.append_scope_event(
                 "channel",
                 channel.id,
                 owner.id,
                 "test.first_tenure",
                 %{}
               )

      assert {:ok, _membership} = Servers.leave_server(member.id, server.id)

      assert {:ok, away_event} =
               Runtime.append_scope_event(
                 "channel",
                 channel.id,
                 owner.id,
                 "test.away",
                 %{}
               )

      assert {:ok, _server} = Servers.join_server(member, server.invite_code)
      second_membership = Servers.get_membership(member.id, server.id)

      assert {:ok, post_rejoin} =
               Runtime.append_scope_event(
                 "channel",
                 channel.id,
                 owner.id,
                 "test.post_rejoin",
                 %{}
               )

      assert {:ok, authorization} =
               ControllerHelpers.authorize_history_scope(member.id, channel.id)

      assert authorization.authorization_generation == second_membership.id
      refute authorization.authorization_generation == first_membership.id
      assert authorization.authorized_after_room_seq == away_event.room_seq
      assert post_rejoin.room_seq > authorization.authorized_after_room_seq
    end

    test "a DM request is bound to the participant tenure and conversation room" do
      alice = insert_user()
      bob = insert_user()
      assert {:ok, conversation} = Chat.create_conversation(alice.id, [bob.id])
      participant = Chat.get_participant(bob.id, conversation.id)

      assert {:ok, authorization} =
               ControllerHelpers.authorize_history_scope(bob.id, conversation.id)

      assert authorization.authorization_generation == participant.id
      assert authorization.authorized_after_room_seq == 0
    end
  end

  describe "history signature revisions" do
    test "concurrent edits cannot publish two plaintexts under one revision" do
      owner = insert_user()
      {:ok, server} = Servers.create_server(owner, %{name: "History revisions"})
      channel = Enum.find(server.channels, &(&1.type == "text"))

      assert {:ok, message} =
               Chat.create_message(%{
                 ciphertext: <<1, 2, 3>>,
                 mls_epoch: 0,
                 encryption_scheme: "mls",
                 channel_id: channel.id,
                 sender_id: owner.id,
                 client_nonce: Ecto.UUID.generate(),
                 history_signing_public_key: :binary.copy(<<7>>, 32),
                 history_revision: 0
               })

      parent = self()

      edits =
        for marker <- [8, 9] do
          Task.async(fn ->
            Ecto.Adapters.SQL.Sandbox.allow(Repo, parent, self())

            Chat.update_message_revision(message.id, owner.id, 1, %{
              ciphertext: :binary.copy(<<marker>>, 3),
              mls_epoch: 1,
              encryption_scheme: "mls",
              history_signing_public_key: :binary.copy(<<marker>>, 32)
            })
          end)
        end
        |> Enum.map(&Task.await(&1, 5_000))

      assert Enum.count(edits, &match?({:ok, _message}, &1)) == 1
      assert Enum.count(edits, &match?({:error, :stale_history_revision}, &1)) == 1
      assert Repo.get!(Vesper.Chat.Message, message.id).history_revision == 1
    end
  end

  describe "request-bound bundle fulfillment" do
    test "copies the authenticated fence and atomically consumes the request" do
      requester = insert_user()
      sponsor = insert_user()
      group_id = Ecto.UUID.generate()
      authorization_generation = Ecto.UUID.generate()

      assert {:ok, request} =
               Encryption.store_pending_history_request(%{
                 group_id: group_id,
                 requester_id: requester.id,
                 requester_client_id: "requester-device",
                 membership_generation: 4,
                 authorization_generation: authorization_generation,
                 authorized_after_room_seq: 12
               })

      assert {:ok, bundle} =
               Encryption.fulfill_pending_history_request(request.id, %{
                 group_id: group_id,
                 ciphertext: "opaque",
                 mls_epoch: 4,
                 recipient_id: requester.id,
                 recipient_client_id: "requester-device",
                 sender_id: sponsor.id,
                 membership_generation: 4,
                 current_authorization_generation: authorization_generation
               })

      assert bundle.request_id == request.id
      assert bundle.membership_generation == 4
      assert bundle.authorization_generation == authorization_generation
      assert bundle.authorized_after_room_seq == 12
      assert Encryption.get_pending_history_request(request.id) == nil
    end

    test "rejects a stale application generation without consuming the request" do
      requester = insert_user()
      sponsor = insert_user()
      group_id = Ecto.UUID.generate()
      authorization_generation = Ecto.UUID.generate()

      assert {:ok, request} =
               Encryption.store_pending_history_request(%{
                 group_id: group_id,
                 requester_id: requester.id,
                 requester_client_id: "requester-device",
                 membership_generation: 4,
                 authorization_generation: authorization_generation,
                 authorized_after_room_seq: 12
               })

      assert {:error, :history_request_authorization_stale} =
               Encryption.fulfill_pending_history_request(request.id, %{
                 group_id: group_id,
                 ciphertext: "opaque",
                 mls_epoch: 4,
                 recipient_id: requester.id,
                 recipient_client_id: "requester-device",
                 sender_id: sponsor.id,
                 membership_generation: 4,
                 current_authorization_generation: Ecto.UUID.generate()
               })

      assert Encryption.get_pending_history_request(request.id)
    end

    test "only returns bound bundles for the current application generation" do
      requester = insert_user()
      sponsor = insert_user()
      group_id = Ecto.UUID.generate()
      current_generation = Ecto.UUID.generate()

      assert {:ok, bound_bundle} =
               Encryption.store_pending_history_bundle(%{
                 group_id: group_id,
                 ciphertext: "current",
                 mls_epoch: 2,
                 recipient_id: requester.id,
                 recipient_client_id: "requester-device",
                 sender_id: sponsor.id,
                 request_id: Ecto.UUID.generate(),
                 membership_generation: 2,
                 authorization_generation: current_generation,
                 authorized_after_room_seq: 3
               })

      assert {:ok, _unbound_bundle} =
               Encryption.store_pending_history_bundle(%{
                 group_id: group_id,
                 ciphertext: "device-epoch-bounded",
                 mls_epoch: 2,
                 recipient_id: requester.id,
                 recipient_client_id: "requester-device",
                 sender_id: sponsor.id
               })

      current_bundles =
        Encryption.get_pending_history_bundles(
          requester.id,
          group_id,
          "requester-device",
          current_generation
        )

      assert [%{ciphertext: "current"}] = current_bundles

      assert [] =
               Encryption.get_pending_history_bundles(
                 requester.id,
                 group_id,
                 "requester-device",
                 Ecto.UUID.generate()
               )

      assert Repo.get!(Vesper.Encryption.PendingHistoryBundle, bound_bundle.id).authorization_generation ==
               current_generation
    end
  end
end
