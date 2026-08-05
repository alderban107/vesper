defmodule Vesper.EncryptionTest do
  use Vesper.DataCase, async: true

  import Ecto.Query

  alias Vesper.Accounts
  alias Vesper.Dispatch
  alias Vesper.DispatchOutbox
  alias Vesper.Encryption

  alias Vesper.Encryption.{
    ControlOperation,
    KeyPackage,
    PendingCryptoEviction,
    PendingWelcome,
    ScopeRecoveryPackage
  }

  alias Vesper.Repo
  alias Vesper.Servers
  alias Vesper.Workers.ProcessPendingCryptoEvictions
  alias Oban.Testing

  describe "control operation idempotency" do
    test "returns the original durable result for duplicate payloads and rejects key conflicts before mutation" do
      actor = insert_user()
      recipient = insert_user()
      group_id = Ecto.UUID.generate()
      idempotency_key = Ecto.UUID.generate()

      attrs = %{
        actor_id: actor.id,
        actor_client_id: "actor-client",
        scope_kind: "channel",
        scope_id: group_id,
        operation: "mls_welcome",
        idempotency_key: idempotency_key
      }

      payload = %{
        recipient_id: recipient.id,
        recipient_client_id: "recipient-client",
        welcome_data: Base.encode64(<<1, 2, 3>>)
      }

      operation = fn ->
        with {:ok, welcome} <-
               Encryption.store_pending_welcome(%{
                 recipient_id: recipient.id,
                 recipient_client_id: "recipient-client",
                 group_id: group_id,
                 welcome_data: <<1, 2, 3>>,
                 sender_id: actor.id
               }) do
          {:ok, %{"id" => welcome.id}}
        end
      end

      assert {:ok, %{"id" => welcome_id}, :new} =
               Encryption.run_control_operation(attrs, payload, operation)

      assert {:ok, %{"id" => ^welcome_id}, :duplicate} =
               Encryption.run_control_operation(attrs, payload, operation)

      assert Repo.aggregate(PendingWelcome, :count) == 1
      assert Repo.aggregate(ControlOperation, :count) == 1

      conflicting_payload = Map.put(payload, :welcome_data, Base.encode64(<<9, 9, 9>>))

      assert {:error, :idempotency_conflict} =
               Encryption.run_control_operation(attrs, conflicting_payload, fn ->
                 Encryption.store_pending_welcome(%{
                   recipient_id: recipient.id,
                   recipient_client_id: "other-client",
                   group_id: group_id,
                   welcome_data: <<9, 9, 9>>,
                   sender_id: actor.id
                 })
                 |> case do
                   {:ok, welcome} -> {:ok, %{"id" => welcome.id}}
                   {:error, reason} -> {:error, reason}
                 end
               end)

      assert Repo.aggregate(PendingWelcome, :count) == 1
      assert Repo.aggregate(ControlOperation, :count) == 1
    end
  end

  describe "bounded scope recovery packages" do
    test "stores opaque bytes and never replaces a newer generation or cursor" do
      owner = insert_user()
      scope_id = Ecto.UUID.generate()
      expires_at = DateTime.utc_now() |> DateTime.add(3600, :second) |> DateTime.truncate(:second)

      attrs = %{
        owner_id: owner.id,
        scope_id: scope_id,
        ciphertext: "opaque-new",
        nonce: :crypto.strong_rand_bytes(12),
        membership_generation: 4,
        last_event_seq: 12,
        schema_version: 1,
        byte_size: 22,
        expires_at: expires_at
      }

      assert {:ok, stored} = Encryption.upsert_scope_recovery_package(attrs)
      assert stored.ciphertext == "opaque-new"

      assert {:ok, stale_generation} =
               Encryption.upsert_scope_recovery_package(%{
                 attrs
                 | ciphertext: "opaque-old-generation",
                   membership_generation: 3,
                   last_event_seq: 99
               })

      assert stale_generation.id == stored.id
      assert stale_generation.ciphertext == "opaque-new"

      assert {:ok, stale_cursor} =
               Encryption.upsert_scope_recovery_package(%{
                 attrs
                 | ciphertext: "opaque-old-cursor",
                   last_event_seq: 11
               })

      assert stale_cursor.id == stored.id
      assert stale_cursor.ciphertext == "opaque-new"

      assert {:ok, advanced} =
               Encryption.upsert_scope_recovery_package(%{
                 attrs
                 | ciphertext: "opaque-advanced",
                   last_event_seq: 13
               })

      assert advanced.id == stored.id
      assert advanced.ciphertext == "opaque-advanced"

      assert Encryption.get_scope_recovery_package(owner.id, scope_id).ciphertext ==
               "opaque-advanced"
    end

    test "does not return expired packages" do
      owner = insert_user()
      scope_id = Ecto.UUID.generate()

      assert {:ok, _package} =
               Encryption.upsert_scope_recovery_package(%{
                 owner_id: owner.id,
                 scope_id: scope_id,
                 ciphertext: "opaque",
                 nonce: :crypto.strong_rand_bytes(12),
                 membership_generation: 1,
                 last_event_seq: 1,
                 schema_version: 1,
                 byte_size: 18,
                 expires_at:
                   DateTime.utc_now() |> DateTime.add(-1, :second) |> DateTime.truncate(:second)
               })

      assert Encryption.get_scope_recovery_package(owner.id, scope_id) == nil
      assert Repo.aggregate(ScopeRecoveryPackage, :count) == 1

      assert {:ok, %{scope_recovery_packages: 1, room_key_epochs: 0}} =
               Encryption.purge_expired_recovery_material()

      assert Repo.aggregate(ScopeRecoveryPackage, :count) == 0
    end
  end

  describe "key package scoping" do
    test "fetches the newest package when no client id is provided" do
      user = insert_user()

      older_package = <<1, 2, 3>>
      newer_package = <<4, 5, 6>>
      older_time = ~U[2026-03-16 10:00:00Z]
      newer_time = ~U[2026-03-16 10:00:01Z]

      Encryption.upload_key_packages(user.id, "client-a", [older_package])
      Encryption.upload_key_packages(user.id, "client-b", [newer_package])

      Repo.update_all(
        from(kp in KeyPackage,
          where: kp.user_id == ^user.id and kp.client_id == "client-a"
        ),
        set: [inserted_at: older_time]
      )

      Repo.update_all(
        from(kp in KeyPackage,
          where: kp.user_id == ^user.id and kp.client_id == "client-b"
        ),
        set: [inserted_at: newer_time]
      )

      assert Encryption.fetch_and_consume_key_package(user.id) == newer_package
      assert Encryption.count_key_packages(user.id, "client-a") == 1
      assert Encryption.count_key_packages(user.id, "client-b") == 0
    end

    test "only purges packages for the requested client id" do
      user = insert_user()

      Encryption.upload_key_packages(user.id, "client-a", [<<1>>])
      Encryption.upload_key_packages(user.id, "client-b", [<<2>>, <<3>>])

      assert {2, nil} = Encryption.purge_key_packages(user.id, "client-b")
      assert Encryption.count_key_packages(user.id, "client-a") == 1
      assert Encryption.count_key_packages(user.id, "client-b") == 0
    end
  end

  describe "pending welcome storage" do
    test "accepts long key package references" do
      recipient = insert_user()
      sender = insert_user()
      long_key_package_ref = String.duplicate("A", 512)

      assert {:ok, welcome} =
               Encryption.store_pending_welcome(%{
                 recipient_id: recipient.id,
                 recipient_client_id: "client-a",
                 recipient_key_package_ref: long_key_package_ref,
                 group_id: Ecto.UUID.generate(),
                 welcome_data: <<1, 2, 3>>,
                 sender_id: sender.id
               })

      assert welcome.recipient_key_package_ref == long_key_package_ref
    end
  end

  describe "pending resync request scoping" do
    test "stores separate requests per requester client id" do
      requester = insert_user()
      group_id = Ecto.UUID.generate()

      assert {:ok, _request} =
               Encryption.store_pending_resync_request(%{
                 group_id: group_id,
                 request_id: "request-a",
                 requester_id: requester.id,
                 requester_username: requester.username,
                 requester_client_id: "client-a"
               })

      assert {:ok, _request} =
               Encryption.store_pending_resync_request(%{
                 "group_id" => group_id,
                 "request_id" => "request-b",
                 "requester_id" => requester.id,
                 "requester_username" => requester.username,
                 "requester_client_id" => "client-b"
               })

      requests = Encryption.get_pending_resync_requests(group_id)

      assert Enum.map(requests, & &1.requester_client_id) == ["client-a", "client-b"]
      assert Enum.map(requests, & &1.request_id) == ["request-a", "request-b"]
    end

    test "stale delete does not remove a refreshed request for the same device" do
      requester = insert_user()
      group_id = Ecto.UUID.generate()

      assert {:ok, initial_request} =
               Encryption.store_pending_resync_request(%{
                 group_id: group_id,
                 request_id: "request-a",
                 requester_id: requester.id,
                 requester_username: requester.username,
                 requester_client_id: "client-a"
               })

      assert {:ok, _refreshed_request} =
               Encryption.store_pending_resync_request(%{
                 group_id: group_id,
                 request_id: "request-b",
                 requester_id: requester.id,
                 requester_username: requester.username,
                 requester_client_id: "client-a"
               })

      [refreshed_request] = Encryption.get_pending_resync_requests(group_id)
      assert refreshed_request.id == initial_request.id
      assert refreshed_request.request_id == "request-b"

      assert {0, nil} =
               Encryption.delete_pending_resync_request(initial_request.id, "request-a")

      [pending_request] = Encryption.get_pending_resync_requests(group_id)
      assert pending_request.id == initial_request.id
      assert pending_request.request_id == "request-b"

      assert {1, nil} =
               Encryption.delete_pending_resync_request(initial_request.id, "request-b")

      assert Encryption.get_pending_resync_requests(group_id) == []
    end
  end

  describe "durable MLS events" do
    test "lists replayable MLS events in sequence order after a cursor" do
      sender = insert_user()
      group_id = Ecto.UUID.generate()

      assert {:ok, first_event} =
               Encryption.store_mls_event(%{
                 group_id: group_id,
                 event_type: "mls_commit",
                 payload: %{commit_data: "commit-a"},
                 sender_id: sender.id,
                 sender_device_id: "device-a"
               })

      assert {:ok, second_event} =
               Encryption.store_mls_event(%{
                 group_id: group_id,
                 event_type: "mls_remove",
                 payload: %{removed_user_id: sender.id, commit_data: "commit-b"},
                 sender_id: sender.id,
                 sender_device_id: "device-b"
               })

      events = Encryption.list_mls_events_after(group_id, first_event.id)

      assert Enum.map(events, & &1.id) == [second_event.id]
      assert Enum.map(events, & &1.event_type) == ["mls_remove"]
      assert Enum.map(events, & &1.payload["commit_data"]) == ["commit-b"]
    end

    test "lists the newest replayable MLS events first" do
      sender = insert_user()
      group_id = Ecto.UUID.generate()

      assert {:ok, old_event} =
               Encryption.store_mls_event(%{
                 group_id: group_id,
                 event_type: "mls_request_join_all",
                 payload: %{user_id: sender.id},
                 sender_id: sender.id,
                 sender_device_id: "device-a"
               })

      assert {:ok, new_event} =
               Encryption.store_mls_event(%{
                 group_id: group_id,
                 event_type: "mls_request_join_all",
                 payload: %{user_id: sender.id},
                 sender_id: sender.id,
                 sender_device_id: "device-b"
               })

      assert Enum.map(Encryption.list_recent_mls_events(group_id, 1), & &1.id) == [new_event.id]

      assert Enum.map(Encryption.list_recent_mls_events(group_id, 2), & &1.id) == [
               new_event.id,
               old_event.id
             ]
    end
  end

  describe "group info publishing" do
    test "serializes concurrent first CAS publishes into one success and conflicts" do
      publisher = insert_user()
      group_id = Ecto.UUID.generate()
      parent = self()
      start_ref = make_ref()

      base_attrs = %{
        group_id: group_id,
        group_info_data: <<1, 2, 3>>,
        ratchet_tree_data: <<4, 5, 6>>,
        epoch: 1,
        previous_epoch: 0,
        previous_transcript_hash: Encryption.initial_mls_transcript_hash(),
        publisher_id: publisher.id,
        commit_data: "concurrent-external-commit",
        commit_id: "concurrent-external-commit"
      }

      tasks =
        1..8
        |> Enum.map(fn index ->
          Task.async(fn ->
            Ecto.Adapters.SQL.Sandbox.allow(Repo, parent, self())
            send(parent, {:ready, self()})

            receive do
              {:go, ^start_ref} -> :ok
            end

            Encryption.publish_external_commit_group_info(
              Map.put(base_attrs, :publisher_client_id, "client-#{index}")
            )
          end)
        end)

      for _ <- tasks do
        assert_receive {:ready, _pid}, 1_000
      end

      Enum.each(tasks, fn task ->
        send(task.pid, {:go, start_ref})
      end)

      results = Enum.map(tasks, &Task.await(&1, 5_000))

      assert Enum.count(results, &match?({:ok, _group_info}, &1)) == 1
      assert Enum.count(results, &(&1 == {:error, :epoch_conflict})) == 7
      assert %{epoch: 1} = Encryption.get_group_info(group_id)
    end

    test "epoch-zero non-CAS publish elects the first payload" do
      publisher = insert_user()
      group_id = Ecto.UUID.generate()

      assert {:ok, first_publish} =
               Encryption.publish_group_info(%{
                 group_id: group_id,
                 group_info_data: <<1, 2, 3>>,
                 ratchet_tree_data: <<4, 5, 6>>,
                 epoch: 0,
                 publisher_id: publisher.id,
                 publisher_client_id: "client-a"
               })

      assert {:ok, duplicate_publish} =
               Encryption.publish_group_info(%{
                 group_id: group_id,
                 group_info_data: <<1, 2, 3>>,
                 ratchet_tree_data: <<4, 5, 6>>,
                 epoch: 0,
                 publisher_id: publisher.id,
                 publisher_client_id: "client-a"
               })

      assert {:error, :epoch_conflict} =
               Encryption.publish_group_info(%{
                 group_id: group_id,
                 group_info_data: <<9, 9, 9>>,
                 ratchet_tree_data: <<8, 8, 8>>,
                 epoch: 0,
                 publisher_id: publisher.id,
                 publisher_client_id: "client-b"
               })

      stored = Encryption.get_group_info(group_id)

      assert stored.id == first_publish.id
      assert duplicate_publish.id == first_publish.id
      assert stored.group_info_data == <<1, 2, 3>>
      assert stored.ratchet_tree_data == <<4, 5, 6>>
    end

    test "rejects a nonzero GroupInfo publish without its durable MLS transition" do
      publisher = insert_user()
      group_id = Ecto.UUID.generate()

      assert {:error, :transition_required} =
               Encryption.publish_group_info(%{
                 group_id: group_id,
                 group_info_data: <<1, 2, 3>>,
                 ratchet_tree_data: <<4, 5, 6>>,
                 epoch: 1,
                 publisher_id: publisher.id,
                 publisher_client_id: "client-a"
               })
    end

    test "atomically stores external commit GroupInfo and durable commit event" do
      publisher = insert_user()
      group_id = Ecto.UUID.generate()

      attrs = %{
        group_id: group_id,
        group_info_data: <<1, 2, 3>>,
        ratchet_tree_data: <<4, 5, 6>>,
        epoch: 1,
        previous_epoch: 0,
        previous_transcript_hash: Encryption.initial_mls_transcript_hash(),
        publisher_id: publisher.id,
        publisher_client_id: "client-a",
        commit_data: "commit-a",
        commit_id: "commit-1"
      }

      assert {:ok, %{group_info: group_info, event: event}} =
               Encryption.publish_external_commit_group_info(attrs)

      assert group_info.epoch == 1
      assert event.event_type == "mls_commit"
      assert event.payload["commit_data"] == "commit-a"
      assert event.payload["transition_type"] == "external_commit"
      assert event.payload["joined_user_id"] == publisher.id
      assert event.payload["joined_device_id"] == "client-a"
      assert event.payload["resulting_generation"] == 1

      assert [%{id: commit_event_id, payload: %{"commit_data" => "commit-a"}}] =
               Encryption.list_mls_events_after(group_id, 0)

      assert commit_event_id == event.id

      assert {:ok, %{group_info: replayed_group_info, event: replayed_event}} =
               Encryption.publish_external_commit_group_info(attrs)

      assert replayed_group_info.id == group_info.id
      assert replayed_event.id == event.id
      assert length(Encryption.list_mls_events_after(group_id, 0)) == 1
    end

    test "rejects application ciphertext outside the canonical MLS epoch" do
      publisher = insert_user()
      group_id = Ecto.UUID.generate()
      room_id = Ecto.UUID.generate()

      assert {:ok, %{group_info: %{epoch: 1}}} =
               Encryption.publish_external_commit_group_info(%{
                 group_id: group_id,
                 group_info_data: <<1, 2, 3>>,
                 ratchet_tree_data: <<4, 5, 6>>,
                 epoch: 1,
                 previous_epoch: 0,
                 previous_transcript_hash: Encryption.initial_mls_transcript_hash(),
                 publisher_id: publisher.id,
                 publisher_client_id: "client-a",
                 commit_data: "commit-a",
                 commit_id: "application-epoch-commit"
               })

      assert :ok = Encryption.validate_application_scheme(room_id, "mls", 1, group_id)

      assert {:error, :mls_epoch_mismatch} =
               Encryption.validate_application_scheme(room_id, "mls", 0, group_id)

      assert {:error, :mls_epoch_mismatch} =
               Encryption.validate_application_scheme(room_id, "mls", 2, group_id)
    end

    test "atomically stores sponsored transitions and replays them idempotently" do
      sponsor = insert_user()
      recipient = insert_user()
      group_id = Ecto.UUID.generate()

      assert {:ok, group_info} =
               Encryption.publish_group_info(%{
                 group_id: group_id,
                 group_info_data: <<0, 0, 0>>,
                 ratchet_tree_data: <<0, 0, 1>>,
                 epoch: 0,
                 publisher_id: sponsor.id,
                 publisher_client_id: "sponsor-a"
               })

      attrs = %{
        group_id: group_id,
        group_info_data: <<1, 2, 3>>,
        ratchet_tree_data: <<4, 5, 6>>,
        epoch: 1,
        previous_epoch: 0,
        previous_transcript_hash: Encryption.mls_transcript_hash(group_info),
        recipient_id: recipient.id,
        recipient_client_id: "recipient-a",
        recipient_key_package_ref: "kp-ref",
        remove_commit_data: "remove-a",
        commit_data: "commit-a",
        commit_id: "commit-1",
        welcome_data: <<1, 2, 3>>,
        sender_id: sponsor.id,
        sender_device_id: "sponsor-a"
      }

      assert {:ok,
              %{
                fresh: true,
                remove_event: remove_event,
                commit_event: commit_event,
                welcome: welcome
              }} =
               Encryption.publish_sponsored_transition(attrs)

      assert remove_event.event_type == "mls_remove"
      assert remove_event.payload["removed_user_id"] == recipient.id
      assert remove_event.payload["removed_device_id"] == "recipient-a"
      assert remove_event.payload["commit_data"] == "remove-a"
      assert remove_event.payload["resulting_generation"] == 1

      assert commit_event.event_type == "mls_commit"
      assert commit_event.payload["commit_data"] == "commit-a"
      assert commit_event.payload["transition_type"] == "sponsored_join"
      assert commit_event.payload["joined_user_id"] == recipient.id
      assert commit_event.payload["joined_device_id"] == "recipient-a"
      assert commit_event.payload["resulting_generation"] == 1

      assert welcome.recipient_id == recipient.id
      assert welcome.recipient_client_id == "recipient-a"
      assert welcome.recipient_key_package_ref == "kp-ref"

      assert Enum.map(Encryption.list_mls_events_after(group_id, 0), & &1.event_type) == [
               "mls_remove",
               "mls_commit"
             ]

      assert {:ok,
              %{
                fresh: false,
                remove_event: nil,
                commit_event: replayed_commit,
                welcome: replayed_welcome
              }} =
               Encryption.publish_sponsored_transition(attrs)

      assert replayed_commit.id == commit_event.id
      assert replayed_welcome.id == welcome.id
      assert length(Encryption.list_mls_events_after(group_id, 0)) == 2
      assert length(Encryption.get_pending_welcomes(recipient.id, group_id, "recipient-a")) == 1
    end

    test "serializes concurrent sponsored transitions from the same prior epoch" do
      sponsor = insert_user()
      recipient_a = insert_user()
      recipient_b = insert_user()
      group_id = Ecto.UUID.generate()
      parent = self()
      start_ref = make_ref()

      assert {:ok, group_info} =
               Encryption.publish_group_info(%{
                 group_id: group_id,
                 group_info_data: <<0, 0, 0>>,
                 ratchet_tree_data: <<0, 0, 1>>,
                 epoch: 0,
                 publisher_id: sponsor.id,
                 publisher_client_id: "sponsor-base"
               })

      predecessor_hash = Encryption.mls_transcript_hash(group_info)

      attrs_list = [
        %{
          group_id: group_id,
          group_info_data: <<1, 1, 1>>,
          ratchet_tree_data: <<1, 1, 2>>,
          epoch: 1,
          previous_epoch: 0,
          previous_transcript_hash: predecessor_hash,
          recipient_id: recipient_a.id,
          recipient_client_id: "recipient-a",
          recipient_key_package_ref: "kp-a",
          commit_data: "commit-a",
          commit_id: "commit-a",
          welcome_data: <<1, 2, 3>>,
          sender_id: sponsor.id,
          sender_device_id: "sponsor-a"
        },
        %{
          group_id: group_id,
          group_info_data: <<2, 2, 2>>,
          ratchet_tree_data: <<2, 2, 3>>,
          epoch: 1,
          previous_epoch: 0,
          previous_transcript_hash: predecessor_hash,
          recipient_id: recipient_b.id,
          recipient_client_id: "recipient-b",
          recipient_key_package_ref: "kp-b",
          commit_data: "commit-b",
          commit_id: "commit-b",
          welcome_data: <<4, 5, 6>>,
          sender_id: sponsor.id,
          sender_device_id: "sponsor-b"
        }
      ]

      tasks =
        Enum.map(attrs_list, fn attrs ->
          Task.async(fn ->
            Ecto.Adapters.SQL.Sandbox.allow(Repo, parent, self())
            send(parent, {:ready, self()})

            receive do
              {:go, ^start_ref} -> :ok
            end

            Encryption.publish_sponsored_transition(attrs)
          end)
        end)

      for _ <- tasks do
        assert_receive {:ready, _pid}, 1_000
      end

      Enum.each(tasks, fn task ->
        send(task.pid, {:go, start_ref})
      end)

      results = Enum.map(tasks, &Task.await(&1, 5_000))

      assert Enum.count(results, &match?({:ok, %{fresh: true}}, &1)) == 1
      assert Enum.count(results, &(&1 == {:error, :epoch_conflict})) == 1
      assert %{epoch: 1} = Encryption.get_group_info(group_id)
      assert length(Encryption.list_mls_events_after(group_id, 0)) == 1
    end

    test "serializes an ordinary fenced removal against an External Commit from the same predecessor" do
      sponsor = insert_user()
      removed_user = insert_user()
      joining_user = insert_user()
      server = insert_server(sponsor)
      channel = insert_channel(server, %{id: Ecto.UUID.generate()})
      parent = self()
      start_ref = make_ref()

      assert {:ok, group_info} =
               Encryption.publish_group_info(%{
                 group_id: channel.id,
                 group_info_data: <<0>>,
                 ratchet_tree_data: <<0, 1>>,
                 epoch: 0,
                 publisher_id: sponsor.id,
                 publisher_client_id: "sponsor-device"
               })

      assert :ok =
               Encryption.queue_scope_crypto_evictions([
                 %{
                   scope_kind: "channel",
                   scope_id: channel.id,
                   group_id: channel.id,
                   server_id: server.id,
                   target_user_id: removed_user.id,
                   target_device_id: "removed-device",
                   reason: "kicked"
                 }
               ])

      requested =
        case Encryption.list_pending_crypto_evictions("channel", channel.id) do
          [%{status: "pending"}] ->
            Encryption.request_next_pending_crypto_eviction("channel", channel.id)

          [entry] ->
            entry
        end

      assert {:ok, claimed} =
               Encryption.claim_pending_crypto_eviction(
                 requested.id,
                 "channel",
                 channel.id,
                 sponsor.id,
                 "sponsor-device",
                 requested.fencing_token,
                 requested.membership_generation
               )

      predecessor_hash = Encryption.mls_transcript_hash(group_info)

      ordinary_attrs = %{
        group_id: channel.id,
        channel_id: channel.id,
        event_type: "mls_remove",
        payload: %{
          removed_user_id: removed_user.id,
          removed_device_id: "removed-device",
          commit_data: "ordinary-remove"
        },
        group_info_data: <<1>>,
        ratchet_tree_data: <<1, 1>>,
        epoch: 1,
        previous_epoch: 0,
        previous_transcript_hash: predecessor_hash,
        sender_id: sponsor.id,
        sender_device_id: "sponsor-device",
        idempotency_key: "ordinary-remove",
        crypto_evictions: [
          %{
            eviction_id: claimed.id,
            scope_kind: "channel",
            scope_id: channel.id,
            removed_user_id: removed_user.id,
            removed_device_id: "removed-device",
            sponsor_user_id: sponsor.id,
            sponsor_device_id: "sponsor-device",
            fencing_token: claimed.fencing_token,
            membership_generation: claimed.membership_generation
          }
        ]
      }

      external_attrs = %{
        group_id: channel.id,
        channel_id: channel.id,
        group_info_data: <<2>>,
        ratchet_tree_data: <<2, 2>>,
        epoch: 1,
        previous_epoch: 0,
        previous_transcript_hash: predecessor_hash,
        publisher_id: joining_user.id,
        publisher_client_id: "joining-device",
        commit_data: "external-commit",
        commit_id: "external-commit"
      }

      tasks =
        [
          fn -> Encryption.publish_ordinary_transition(ordinary_attrs) end,
          fn -> Encryption.publish_external_commit_group_info(external_attrs) end
        ]
        |> Enum.map(fn operation ->
          Task.async(fn ->
            Ecto.Adapters.SQL.Sandbox.allow(Repo, parent, self())
            send(parent, {:ready, self()})

            receive do
              {:go, ^start_ref} -> operation.()
            end
          end)
        end)

      for _ <- tasks, do: assert_receive({:ready, _pid}, 1_000)
      Enum.each(tasks, &send(&1.pid, {:go, start_ref}))
      results = Enum.map(tasks, &Task.await(&1, 5_000))

      assert Enum.count(results, &match?({:ok, _}, &1)) == 1
      assert Enum.count(results, &(&1 == {:error, :epoch_conflict})) == 1
      assert %{epoch: 1} = Encryption.get_group_info(channel.id)
      assert [_event] = Encryption.list_mls_events_after(channel.id)
    end

    test "keeps sponsored dispatch durable across a failed broadcast and idempotent retry" do
      sponsor = insert_user()
      recipient = insert_user()
      group_id = Ecto.UUID.generate()

      assert {:ok, group_info} =
               Encryption.publish_group_info(%{
                 group_id: group_id,
                 group_info_data: <<0>>,
                 epoch: 0,
                 publisher_id: sponsor.id,
                 publisher_client_id: "sponsor-device"
               })

      attrs = %{
        group_id: group_id,
        group_info_data: <<1>>,
        epoch: 1,
        previous_epoch: 0,
        previous_transcript_hash: Encryption.mls_transcript_hash(group_info),
        recipient_id: recipient.id,
        recipient_client_id: "recipient-device",
        commit_data: "sponsored-commit",
        commit_id: "sponsored-commit",
        sender_id: sponsor.id,
        sender_device_id: "sponsor-device"
      }

      Testing.with_testing_mode(:manual, fn ->
        assert {:ok, %{fresh: true, commit_event: commit_event}} =
                 Encryption.publish_sponsored_transition(attrs)

        dispatch = Repo.get_by!(DispatchOutbox, durable_key: "mls_event:#{commit_event.id}")

        assert {:error, "dropped sponsored broadcast"} =
                 Dispatch.deliver(dispatch.id, fn _topic, _event, _payload ->
                   raise "dropped sponsored broadcast"
                 end)

        assert Repo.get!(DispatchOutbox, dispatch.id).status == "failed"

        assert {:ok, %{fresh: false, commit_event: replayed_event}} =
                 Encryption.publish_sponsored_transition(attrs)

        assert replayed_event.id == commit_event.id

        parent = self()

        assert :ok =
                 Dispatch.deliver(dispatch.id, fn topic, event, payload ->
                   send(parent, {:sponsored_broadcast, topic, event, payload})
                   :ok
                 end)

        assert_receive {:sponsored_broadcast, "group:" <> ^group_id, "mls_commit", payload}
        assert payload["seq"] == commit_event.id
        assert Repo.get!(DispatchOutbox, dispatch.id).status == "delivered"
      end)
    end
  end

  describe "pending crypto evictions" do
    test "duplicate scope enqueue is treated as benign" do
      scope_id = Ecto.UUID.generate()

      Testing.with_testing_mode(:manual, fn ->
        assert :ok =
                 Encryption.enqueue_crypto_eviction_scope("channel", scope_id, schedule_in: 30)

        assert :ok =
                 Encryption.enqueue_crypto_eviction_scope("channel", scope_id, schedule_in: 30)

        queued_jobs =
          Testing.all_enqueued(Vesper.Repo,
            worker: ProcessPendingCryptoEvictions,
            args: %{"scope_kind" => "channel", "scope_id" => scope_id}
          )

        assert length(queued_jobs) == 1
      end)
    end

    test "worker uniqueness allows a retry to be queued while a pass is executing" do
      unique_states =
        ProcessPendingCryptoEvictions.new(%{"scope_kind" => "channel", "scope_id" => "scope-1"})
        |> Map.fetch!(:changes)
        |> Map.fetch!(:unique)
        |> Map.fetch!(:states)

      refute :executing in unique_states
    end

    test "rejoining cancels stale membership evictions before they can be claimed" do
      sponsor = insert_user()
      target = insert_user()
      server = insert_server(sponsor)
      channel = insert_channel(server, %{id: Ecto.UUID.generate()})

      assert :ok =
               Encryption.queue_scope_crypto_evictions([
                 %{
                   scope_kind: "channel",
                   scope_id: channel.id,
                   group_id: channel.id,
                   server_id: server.id,
                   target_user_id: target.id,
                   target_device_id: "target-a",
                   reason: "left"
                 }
               ])

      assert {:ok, _server} = Servers.join_server(target, server.invite_code)

      [cancelled] = Encryption.list_pending_crypto_evictions("channel", channel.id)
      assert cancelled.status == "cancelled"
      assert cancelled.last_error == "target_rejoined"

      assert {:error, :target_rejoined} =
               Encryption.claim_pending_crypto_eviction(
                 cancelled.id,
                 "channel",
                 channel.id,
                 sponsor.id,
                 "sponsor-a",
                 cancelled.fencing_token,
                 cancelled.membership_generation
               )
    end

    test "completes an eviction and purges target-scoped artifacts" do
      sponsor = insert_user()
      target = insert_user()
      server = insert_server(sponsor)
      channel = insert_channel(server, %{id: Ecto.UUID.generate()})

      assert {:ok, _device} =
               Accounts.ensure_device(
                 target,
                 %{client_id: "target-a", name: "Target A"},
                 "trusted"
               )

      assert {:ok, _device} =
               Accounts.ensure_device(
                 sponsor,
                 %{client_id: "sponsor-a", name: "Sponsor A"},
                 "trusted"
               )

      assert {:ok, _welcome} =
               Encryption.store_pending_welcome(%{
                 recipient_id: target.id,
                 recipient_client_id: "target-a",
                 recipient_key_package_ref: "kp-ref",
                 group_id: channel.id,
                 channel_id: channel.id,
                 welcome_data: <<1, 2, 3>>,
                 sender_id: sponsor.id
               })

      assert {:ok, history_request} =
               Encryption.store_pending_history_request(%{
                 group_id: channel.id,
                 requester_id: target.id,
                 requester_username: target.username,
                 requester_client_id: "target-a",
                 membership_generation: 7,
                 authorization_generation: Ecto.UUID.generate(),
                 authorized_after_room_seq: 0,
                 channel_id: channel.id
               })

      assert history_request.membership_generation == 7

      assert {:ok, _history_bundle} =
               Encryption.store_pending_history_bundle(%{
                 group_id: channel.id,
                 ciphertext: "ciphertext",
                 mls_epoch: 7,
                 recipient_id: target.id,
                 recipient_client_id: "target-a",
                 sender_id: sponsor.id,
                 channel_id: channel.id
               })

      assert {:ok, _resync_request} =
               Encryption.store_pending_resync_request(%{
                 group_id: channel.id,
                 request_id: "resync-1",
                 requester_id: target.id,
                 requester_username: target.username,
                 requester_client_id: "target-a",
                 channel_id: channel.id
               })

      assert :ok =
               Encryption.queue_scope_crypto_evictions([
                 %{
                   scope_kind: "channel",
                   scope_id: channel.id,
                   group_id: channel.id,
                   server_id: server.id,
                   target_user_id: target.id,
                   target_device_id: "target-a",
                   reason: "kicked"
                 }
               ])

      requested =
        case Encryption.list_pending_crypto_evictions("channel", channel.id) do
          [%{status: "pending"}] ->
            Encryption.request_next_pending_crypto_eviction("channel", channel.id)

          [entry] ->
            entry
        end

      assert {:ok, claimed} =
               Encryption.claim_pending_crypto_eviction(
                 requested.id,
                 "channel",
                 channel.id,
                 sponsor.id,
                 "sponsor-a",
                 requested.fencing_token,
                 requested.membership_generation
               )

      assert claimed.status == "claimed"

      assert {:ok, event} =
               Encryption.store_mls_remove_event(
                 %{
                   group_id: channel.id,
                   channel_id: channel.id,
                   event_type: "mls_remove",
                   payload: %{
                     removed_user_id: target.id,
                     removed_device_id: "target-a",
                     commit_data: "commit-data",
                     eviction_id: requested.id
                   },
                   sender_id: sponsor.id,
                   sender_device_id: "sponsor-a"
                 },
                 %{
                   eviction_id: requested.id,
                   scope_kind: "channel",
                   scope_id: channel.id,
                   removed_user_id: target.id,
                   removed_device_id: "target-a",
                   sponsor_user_id: sponsor.id,
                   sponsor_device_id: "sponsor-a",
                   fencing_token: requested.fencing_token,
                   membership_generation: requested.membership_generation
                 }
               )

      [completed] = Encryption.list_pending_crypto_evictions("channel", channel.id)

      assert completed.status == "committed"
      assert completed.commit_event_id == event.id
      assert completed.sponsor_user_id == sponsor.id
      assert completed.sponsor_device_id == "sponsor-a"
      assert Encryption.get_pending_welcomes(target.id, channel.id, "target-a") == []
      assert Encryption.get_pending_history_requests(channel.id) == []
      assert Encryption.get_pending_history_bundles(target.id, channel.id, "target-a") == []
      assert Encryption.get_pending_resync_requests(channel.id) == []
    end

    test "rolls back the remove event when eviction completion fails" do
      sponsor = insert_user()
      target = insert_user()
      server = insert_server(sponsor)
      channel = insert_channel(server, %{id: Ecto.UUID.generate()})

      assert {:ok, _device} =
               Accounts.ensure_device(
                 target,
                 %{client_id: "target-a", name: "Target A"},
                 "trusted"
               )

      assert {:ok, _device} =
               Accounts.ensure_device(
                 sponsor,
                 %{client_id: "sponsor-a", name: "Sponsor A"},
                 "trusted"
               )

      assert :ok =
               Encryption.queue_scope_crypto_evictions([
                 %{
                   scope_kind: "channel",
                   scope_id: channel.id,
                   group_id: channel.id,
                   server_id: server.id,
                   target_user_id: target.id,
                   target_device_id: "target-a",
                   reason: "kicked"
                 }
               ])

      requested =
        case Encryption.list_pending_crypto_evictions("channel", channel.id) do
          [%{status: "pending"}] ->
            Encryption.request_next_pending_crypto_eviction("channel", channel.id)

          [entry] ->
            entry
        end

      assert {:ok, _claimed} =
               Encryption.claim_pending_crypto_eviction(
                 requested.id,
                 "channel",
                 channel.id,
                 sponsor.id,
                 "sponsor-a",
                 requested.fencing_token,
                 requested.membership_generation
               )

      assert {:error, :target_device_mismatch} =
               Encryption.store_mls_remove_event(
                 %{
                   group_id: channel.id,
                   channel_id: channel.id,
                   event_type: "mls_remove",
                   payload: %{
                     removed_user_id: target.id,
                     removed_device_id: "target-b",
                     commit_data: "commit-data",
                     eviction_id: requested.id
                   },
                   sender_id: sponsor.id,
                   sender_device_id: "sponsor-a"
                 },
                 %{
                   eviction_id: requested.id,
                   scope_kind: "channel",
                   scope_id: channel.id,
                   removed_user_id: target.id,
                   removed_device_id: "target-b",
                   sponsor_user_id: sponsor.id,
                   sponsor_device_id: "sponsor-a",
                   fencing_token: requested.fencing_token,
                   membership_generation: requested.membership_generation
                 }
               )

      assert [] == Encryption.list_mls_events_after(channel.id)

      [pending] = Encryption.list_pending_crypto_evictions("channel", channel.id)
      assert pending.status == "claimed"
      assert pending.commit_event_id == nil
    end

    test "sponsor can renew and explicitly abandon one fenced lease" do
      sponsor = insert_user()
      target = insert_user()
      server = insert_server(sponsor)
      channel = insert_channel(server, %{id: Ecto.UUID.generate()})

      assert :ok =
               Encryption.queue_scope_crypto_evictions([
                 %{
                   scope_kind: "channel",
                   scope_id: channel.id,
                   group_id: channel.id,
                   server_id: server.id,
                   target_user_id: target.id,
                   target_device_id: "target-a",
                   reason: "kicked"
                 }
               ])

      requested =
        case Encryption.list_pending_crypto_evictions("channel", channel.id) do
          [%{status: "pending"}] ->
            Encryption.request_next_pending_crypto_eviction("channel", channel.id)

          [entry] ->
            entry
        end

      assert {:ok, claimed} =
               Encryption.claim_pending_crypto_eviction(
                 requested.id,
                 "channel",
                 channel.id,
                 sponsor.id,
                 "sponsor-a",
                 requested.fencing_token,
                 requested.membership_generation
               )

      assert {:ok, renewed} =
               Encryption.renew_pending_crypto_eviction(
                 claimed.id,
                 "channel",
                 channel.id,
                 sponsor.id,
                 "sponsor-a",
                 claimed.fencing_token
               )

      assert DateTime.compare(renewed.lease_expires_at, claimed.lease_expires_at) in [:eq, :gt]

      assert {:ok, abandoned} =
               Encryption.abandon_pending_crypto_eviction(
                 renewed.id,
                 "channel",
                 channel.id,
                 sponsor.id,
                 "sponsor-a",
                 renewed.fencing_token,
                 "sponsor_stopping"
               )

      assert abandoned.status == "requested"
      assert abandoned.sponsor_user_id == nil
      assert abandoned.sponsor_device_id == nil
      assert abandoned.lease_expires_at == nil
      assert abandoned.last_error == "sponsor_stopping"
    end

    test "clustered removals complete through one durable MLS event" do
      sponsor = insert_user()
      target_a = insert_user()
      target_b = insert_user()
      server = insert_server(sponsor)
      channel = insert_channel(server, %{id: Ecto.UUID.generate()})

      assert :ok =
               Encryption.queue_scope_crypto_evictions(
                 Enum.map([target_a, target_b], fn target ->
                   %{
                     scope_kind: "channel",
                     scope_id: channel.id,
                     group_id: channel.id,
                     server_id: server.id,
                     target_user_id: target.id,
                     target_device_id: "device-#{target.id}",
                     reason: "kicked"
                   }
                 end)
               )

      requested =
        case Encryption.list_pending_crypto_evictions("channel", channel.id) do
          [%{status: "pending"}, %{status: "pending"}] ->
            Encryption.request_pending_crypto_eviction_batch("channel", channel.id)

          entries ->
            entries
        end

      assert length(requested) == 2
      assert Enum.all?(requested, &(&1.attempt_count == 1))
      assert Enum.uniq_by(requested, & &1.membership_generation) |> length() == 1

      claimed =
        Enum.map(requested, fn eviction ->
          assert {:ok, claimed_eviction} =
                   Encryption.claim_pending_crypto_eviction(
                     eviction.id,
                     "channel",
                     channel.id,
                     sponsor.id,
                     "sponsor-a",
                     eviction.fencing_token,
                     eviction.membership_generation
                   )

          claimed_eviction
        end)

      removals =
        Enum.map(claimed, fn eviction ->
          %{
            eviction_id: eviction.id,
            scope_kind: "channel",
            scope_id: channel.id,
            removed_user_id: eviction.target_user_id,
            removed_device_id: eviction.target_device_id,
            sponsor_user_id: sponsor.id,
            sponsor_device_id: "sponsor-a",
            fencing_token: eviction.fencing_token,
            membership_generation: eviction.membership_generation
          }
        end)

      assert {:ok, event} =
               Encryption.store_mls_remove_event(
                 %{
                   group_id: channel.id,
                   channel_id: channel.id,
                   event_type: "mls_remove",
                   payload: %{
                     removed_user_id: target_a.id,
                     commit_data: "one-batched-commit",
                     removals: removals
                   },
                   sender_id: sponsor.id,
                   sender_device_id: "sponsor-a"
                 },
                 removals
               )

      completed = Encryption.list_pending_crypto_evictions("channel", channel.id)
      assert Enum.all?(completed, &(&1.status == "committed"))
      assert Enum.all?(completed, &(&1.commit_event_id == event.id))

      assert Enum.map(completed, & &1.target_user_id) |> MapSet.new() ==
               MapSet.new([target_a.id, target_b.id])

      assert Enum.map(Encryption.list_mls_events_after(channel.id), & &1.id) == [event.id]
    end

    test "expired sponsor lease hands off with a newer fence and rejects stale completion" do
      parent = self()
      start_ref = make_ref()
      sponsor_a = insert_user()
      sponsor_b = insert_user()
      target = insert_user()
      server = insert_server(sponsor_a)
      channel = insert_channel(server, %{id: Ecto.UUID.generate()})

      assert {:ok, _server} = Servers.join_server(sponsor_b, server.invite_code)

      assert :ok =
               Encryption.queue_scope_crypto_evictions([
                 %{
                   scope_kind: "channel",
                   scope_id: channel.id,
                   group_id: channel.id,
                   server_id: server.id,
                   target_user_id: target.id,
                   target_device_id: "target-a",
                   reason: "kicked"
                 }
               ])

      requested =
        case Encryption.list_pending_crypto_evictions("channel", channel.id) do
          [%{status: "pending"}] ->
            Encryption.request_next_pending_crypto_eviction("channel", channel.id)

          [entry] ->
            entry
        end

      claimants = [
        {sponsor_a, "sponsor-a"},
        {sponsor_b, "sponsor-b"}
      ]

      tasks =
        Enum.map(claimants, fn {sponsor, device_id} ->
          Task.async(fn ->
            Ecto.Adapters.SQL.Sandbox.allow(Repo, parent, self())
            send(parent, {:ready, self()})

            receive do
              {:go, ^start_ref} -> :ok
            end

            {sponsor, device_id,
             Encryption.claim_pending_crypto_eviction(
               requested.id,
               "channel",
               channel.id,
               sponsor.id,
               device_id,
               requested.fencing_token,
               requested.membership_generation
             )}
          end)
        end)

      for _ <- tasks do
        assert_receive {:ready, _pid}, 1_000
      end

      Enum.each(tasks, &send(&1.pid, {:go, start_ref}))
      results = Enum.map(tasks, &Task.await(&1, 5_000))

      assert Enum.count(results, fn {_sponsor, _device, result} -> match?({:ok, _}, result) end) ==
               1

      {winning_sponsor, winning_device, {:ok, claimed}} =
        Enum.find(results, fn {_sponsor, _device, result} -> match?({:ok, _}, result) end)

      {next_sponsor, next_device} =
        Enum.find(claimants, fn {sponsor, _device} -> sponsor.id != winning_sponsor.id end)

      from(eviction in PendingCryptoEviction, where: eviction.id == ^claimed.id)
      |> Repo.update_all(set: [lease_expires_at: DateTime.utc_now() |> DateTime.add(-1, :second)])

      reissued = Encryption.request_next_pending_crypto_eviction("channel", channel.id)
      assert reissued.fencing_token == claimed.fencing_token + 1
      assert reissued.attempt_count <= 2

      assert {:ok, handed_off} =
               Encryption.claim_pending_crypto_eviction(
                 reissued.id,
                 "channel",
                 channel.id,
                 next_sponsor.id,
                 next_device,
                 reissued.fencing_token,
                 reissued.membership_generation
               )

      stale_eviction = %{
        eviction_id: claimed.id,
        scope_kind: "channel",
        scope_id: channel.id,
        removed_user_id: target.id,
        removed_device_id: "target-a",
        sponsor_user_id: winning_sponsor.id,
        sponsor_device_id: winning_device,
        fencing_token: claimed.fencing_token,
        membership_generation: claimed.membership_generation
      }

      assert {:error, :stale_fence} =
               Encryption.store_mls_remove_event(
                 %{
                   group_id: channel.id,
                   channel_id: channel.id,
                   event_type: "mls_remove",
                   payload: %{removed_user_id: target.id, commit_data: "stale-commit"},
                   sender_id: winning_sponsor.id,
                   sender_device_id: winning_device
                 },
                 stale_eviction
               )

      assert Encryption.list_mls_events_after(channel.id) == []

      assert {:ok, event} =
               Encryption.store_mls_remove_event(
                 %{
                   group_id: channel.id,
                   channel_id: channel.id,
                   event_type: "mls_remove",
                   payload: %{removed_user_id: target.id, commit_data: "winning-commit"},
                   sender_id: next_sponsor.id,
                   sender_device_id: next_device
                 },
                 %{
                   stale_eviction
                   | sponsor_user_id: next_sponsor.id,
                     sponsor_device_id: next_device,
                     fencing_token: handed_off.fencing_token,
                     membership_generation: handed_off.membership_generation
                 }
               )

      [completed] = Encryption.list_pending_crypto_evictions("channel", channel.id)
      assert completed.status == "committed"
      assert completed.commit_event_id == event.id
      assert completed.result["fencing_token"] == handed_off.fencing_token
    end
  end
end
