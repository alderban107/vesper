defmodule Vesper.EncryptionTest do
  use Vesper.DataCase, async: true

  import Ecto.Query

  alias Vesper.Accounts
  alias Vesper.Encryption
  alias Vesper.Encryption.KeyPackage
  alias Vesper.Workers.ProcessPendingCryptoEvictions
  alias Oban.Testing

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
        publisher_id: publisher.id
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

            Encryption.publish_group_info(
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

    test "same-epoch non-CAS publish keeps the existing payload" do
      publisher = insert_user()
      group_id = Ecto.UUID.generate()

      assert {:ok, first_publish} =
               Encryption.publish_group_info(%{
                 group_id: group_id,
                 group_info_data: <<1, 2, 3>>,
                 ratchet_tree_data: <<4, 5, 6>>,
                 epoch: 1,
                 publisher_id: publisher.id,
                 publisher_client_id: "client-a"
               })

      assert {:ok, second_publish} =
               Encryption.publish_group_info(%{
                 group_id: group_id,
                 group_info_data: <<9, 9, 9>>,
                 ratchet_tree_data: <<8, 8, 8>>,
                 epoch: 1,
                 publisher_id: publisher.id,
                 publisher_client_id: "client-b"
               })

      stored = Encryption.get_group_info(group_id)

      assert stored.id == first_publish.id
      assert second_publish.id == first_publish.id
      assert stored.group_info_data == <<1, 2, 3>>
      assert stored.ratchet_tree_data == <<4, 5, 6>>
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

      assert [%{id: commit_event_id, payload: %{"commit_data" => "commit-a"}}] =
               Encryption.list_mls_events_after(group_id, 0)

      assert commit_event_id == event.id

      assert {:ok, %{group_info: replayed_group_info, event: replayed_event}} =
               Encryption.publish_external_commit_group_info(attrs)

      assert replayed_group_info.id == group_info.id
      assert replayed_event.id == event.id
      assert length(Encryption.list_mls_events_after(group_id, 0)) == 1
    end

    test "atomically stores sponsored transitions and replays them idempotently" do
      sponsor = insert_user()
      recipient = insert_user()
      group_id = Ecto.UUID.generate()

      assert {:ok, _group_info} =
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
              %{fresh: true, remove_event: remove_event, commit_event: commit_event, welcome: welcome}} =
               Encryption.publish_sponsored_transition(attrs)

      assert remove_event.event_type == "mls_remove"
      assert remove_event.payload["removed_user_id"] == recipient.id
      assert remove_event.payload["removed_device_id"] == "recipient-a"
      assert remove_event.payload["commit_data"] == "remove-a"

      assert commit_event.event_type == "mls_commit"
      assert commit_event.payload["commit_data"] == "commit-a"

      assert welcome.recipient_id == recipient.id
      assert welcome.recipient_client_id == "recipient-a"
      assert welcome.recipient_key_package_ref == "kp-ref"

      assert Enum.map(Encryption.list_mls_events_after(group_id, 0), & &1.event_type) == [
               "mls_remove",
               "mls_commit"
             ]

      assert {:ok,
              %{fresh: false, remove_event: nil, commit_event: replayed_commit, welcome: replayed_welcome}} =
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

      assert {:ok, _group_info} =
               Encryption.publish_group_info(%{
                 group_id: group_id,
                 group_info_data: <<0, 0, 0>>,
                 ratchet_tree_data: <<0, 0, 1>>,
                 epoch: 0,
                 publisher_id: sponsor.id,
                 publisher_client_id: "sponsor-base"
               })

      attrs_list = [
        %{
          group_id: group_id,
          group_info_data: <<1, 1, 1>>,
          ratchet_tree_data: <<1, 1, 2>>,
          epoch: 1,
          previous_epoch: 0,
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

      assert {:ok, _history_request} =
               Encryption.store_pending_history_request(%{
                 group_id: channel.id,
                 requester_id: target.id,
                 requester_username: target.username,
                 requester_client_id: "target-a",
                 channel_id: channel.id
               })

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

      [eviction] = Encryption.list_pending_crypto_evictions("channel", channel.id)

      assert {:ok, claimed} =
               Encryption.claim_pending_crypto_eviction(
                 eviction.id,
                 "channel",
                 channel.id,
                 sponsor.id,
                 "sponsor-a"
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
                     eviction_id: eviction.id
                   },
                   sender_id: sponsor.id,
                   sender_device_id: "sponsor-a"
                 },
                 %{
                   eviction_id: eviction.id,
                   scope_kind: "channel",
                   scope_id: channel.id,
                   removed_user_id: target.id,
                   removed_device_id: "target-a",
                   sponsor_user_id: sponsor.id,
                   sponsor_device_id: "sponsor-a"
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

      [eviction] = Encryption.list_pending_crypto_evictions("channel", channel.id)

      assert {:ok, _claimed} =
               Encryption.claim_pending_crypto_eviction(
                 eviction.id,
                 "channel",
                 channel.id,
                 sponsor.id,
                 "sponsor-a"
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
                     eviction_id: eviction.id
                   },
                   sender_id: sponsor.id,
                   sender_device_id: "sponsor-a"
                 },
                 %{
                   eviction_id: eviction.id,
                   scope_kind: "channel",
                   scope_id: channel.id,
                   removed_user_id: target.id,
                   removed_device_id: "target-b",
                   sponsor_user_id: sponsor.id,
                   sponsor_device_id: "sponsor-a"
                 }
               )

      assert [] == Encryption.list_mls_events_after(channel.id)

      [pending] = Encryption.list_pending_crypto_evictions("channel", channel.id)
      assert pending.status == "claimed"
      assert pending.commit_event_id == nil
    end
  end
end
