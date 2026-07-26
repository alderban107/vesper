defmodule Vesper.RoomTopologyTest do
  use Vesper.DataCase, async: false

  import Ecto.Query

  alias Vesper.Chat
  alias Vesper.Chat.Message
  alias Vesper.Encryption
  alias Vesper.Encryption.{RoomCohort, RoomCohortMembership, RoomTopology}
  alias Vesper.Repo
  alias Vesper.Runtime
  alias Vesper.Runtime.RoomEvent
  alias Vesper.Servers

  test "single mode preserves the canonical scope identifier" do
    owner = insert_user()
    {:ok, server} = Servers.create_server(owner, %{name: "Single topology"})
    channel = Enum.find(server.channels, &(&1.type == "text"))
    room = Runtime.get_room_for_channel(channel.id)

    assert {:ok, resolution} = Encryption.resolve_room_topology(room.id, owner.id)
    assert resolution.mode == :single
    assert resolution.generation == 1
    assert resolution.target_cohort_size == 512
    assert resolution.group_id == channel.id
    assert resolution.cohort_id == nil
  end

  test "concurrent assignment is unique per user and never exceeds cohort capacity" do
    owner = insert_user()

    users = [
      owner | Enum.map(1..6, fn index -> insert_user(%{username: "cohort_user_#{index}"}) end)
    ]

    {:ok, server} = Servers.create_server(owner, %{name: "Concurrent topology"})
    channel = Enum.find(server.channels, &(&1.type == "text"))
    room = Runtime.get_room_for_channel(channel.id)

    assert {:ok, current} = Encryption.ensure_room_topology(room.id)
    assert current.mode == :single
    assert {:ok, preparing} = Encryption.prepare_room_topology(room.id, :multi_cohort, 2)
    assert {:ok, active} = Encryption.activate_room_topology(preparing.id, room.current_seq)
    assert active.generation == 2

    resolutions =
      users
      |> Enum.flat_map(fn user -> List.duplicate(user, 3) end)
      |> Task.async_stream(
        fn user -> Encryption.resolve_room_topology(room.id, user.id) end,
        max_concurrency: 12,
        ordered: false,
        timeout: 10_000
      )
      |> Enum.map(fn {:ok, {:ok, resolution}} -> resolution end)

    assert length(resolutions) == length(users) * 3

    assert Repo.aggregate(
             from(membership in RoomCohortMembership,
               where: membership.topology_id == ^active.id
             ),
             :count
           ) == length(users)

    memberships_per_user =
      Repo.all(
        from(membership in RoomCohortMembership,
          where: membership.topology_id == ^active.id,
          group_by: membership.user_id,
          select: {membership.user_id, count(membership.id)}
        )
      )

    assert Enum.all?(memberships_per_user, fn {_user_id, count} -> count == 1 end)

    cohort_sizes =
      Repo.all(
        from(cohort in RoomCohort,
          left_join: membership in RoomCohortMembership,
          on: membership.cohort_id == cohort.id,
          where: cohort.topology_id == ^active.id,
          group_by: cohort.id,
          select: {cohort.ordinal, count(membership.id)}
        )
      )

    assert length(cohort_sizes) == 4
    assert Enum.all?(cohort_sizes, fn {_ordinal, count} -> count in 1..2 end)
  end

  test "all resolutions for one user stay on one cohort and active cutover is immutable" do
    owner = insert_user()
    {:ok, server} = Servers.create_server(owner, %{name: "Stable topology"})
    channel = Enum.find(server.channels, &(&1.type == "text"))
    room = Runtime.get_room_for_channel(channel.id)

    assert {:ok, _single} = Encryption.ensure_room_topology(room.id)
    assert {:ok, preparing} = Encryption.prepare_room_topology(room.id, :multi_cohort, 4)
    assert {:ok, active} = Encryption.activate_room_topology(preparing.id, room.current_seq)

    assert {:ok, first} = Encryption.resolve_room_topology(room.id, owner.id)
    assert {:ok, second} = Encryption.resolve_room_topology(room.id, owner.id)
    assert first.cohort_id == second.cohort_id
    assert first.group_id == second.group_id
    assert first.generation == second.generation

    assert {:error, :topology_not_preparing} = Encryption.activate_room_topology(active.id, 8)
    assert Repo.get!(RoomTopology, active.id).cutover_room_seq == room.current_seq
  end

  test "wrapping publications use monotonic epoch CAS and store no private material" do
    owner = insert_user()
    {:ok, server} = Servers.create_server(owner, %{name: "Wrapping CAS"})
    channel = Enum.find(server.channels, &(&1.type == "text"))
    room = Runtime.get_room_for_channel(channel.id)
    assert {:ok, _} = Encryption.ensure_room_topology(room.id)
    assert {:ok, preparing} = Encryption.prepare_room_topology(room.id, :multi_cohort, 2)
    assert {:ok, _} = Encryption.activate_room_topology(preparing.id, 0)
    assert {:ok, resolution} = Encryption.resolve_room_topology(room.id, owner.id)

    attrs = %{
      group_id: resolution.group_id,
      room_id: room.id,
      cohort_id: resolution.cohort_id,
      topology_generation: resolution.generation,
      mls_epoch: 3,
      public_key: :binary.copy(<<1>>, 32),
      signature: :binary.copy(<<2>>, 64),
      signer_identity: "#{owner.id}:device-a",
      signer_public_key: :binary.copy(<<3>>, 32),
      group_info_digest: :binary.copy(<<4>>, 32),
      publisher_id: owner.id,
      publisher_device_id: "device-a"
    }

    assert {:ok, stored} = Encryption.upsert_cohort_wrapping_key(attrs)
    assert {:ok, duplicate} = Encryption.upsert_cohort_wrapping_key(attrs)
    assert duplicate.id == stored.id

    assert {:error, :epoch_conflict} =
             Encryption.upsert_cohort_wrapping_key(%{attrs | public_key: :binary.copy(<<9>>, 32)})

    assert {:error, :epoch_conflict} =
             Encryption.upsert_cohort_wrapping_key(%{attrs | mls_epoch: 2})

    assert Map.keys(Map.from_struct(stored)) |> Enum.all?(&(&1 not in [:private_key, :secret]))
  end

  test "a populated active topology survives rollback of a later preparation" do
    owner = insert_user()
    {:ok, server} = Servers.create_server(owner, %{name: "Rollback topology"})
    channel = Enum.find(server.channels, &(&1.type == "text"))
    room = Runtime.get_room_for_channel(channel.id)

    assert {:ok, _single} = Encryption.ensure_room_topology(room.id)
    assert {:ok, multi} = Encryption.prepare_room_topology(room.id, :multi_cohort, 3)
    assert {:ok, active_multi} = Encryption.activate_room_topology(multi.id, 0)
    assert {:ok, before} = Encryption.resolve_room_topology(room.id, owner.id)

    assert {:ok, candidate} = Encryption.prepare_room_topology(room.id, :single, 100)
    assert {:ok, rolled_back} = Encryption.rollback_preparing_room_topology(room.id, candidate.id)
    assert rolled_back.state == :rolled_back

    assert {:ok, after_rollback} = Encryption.resolve_room_topology(room.id, owner.id)
    assert after_rollback.generation == active_multi.generation
    assert after_rollback.cohort_id == before.cohort_id
    assert after_rollback.group_id == before.group_id
  end

  test "room-key activation is fenced, complete, and idempotent across coordinator handoff" do
    %{owner: owner, peer: peer, room: room, cohorts: cohorts} = room_key_fixture()
    request_id = Ecto.UUID.generate()

    assert {:ok, prepared} =
             Encryption.prepare_room_key_epoch(
               room.id,
               owner.id,
               "owner-device",
               request_id,
               "initial"
             )

    assert prepared.expected_cohort_count == 2

    assert {:ok, duplicate} =
             Encryption.prepare_room_key_epoch(
               room.id,
               owner.id,
               "owner-device",
               request_id,
               "initial"
             )

    assert duplicate.id == prepared.id
    assert duplicate.fencing_token == prepared.fencing_token

    expired_at = DateTime.utc_now() |> DateTime.add(-1, :second) |> DateTime.truncate(:second)

    prepared
    |> Ecto.Changeset.change(lease_expires_at: expired_at)
    |> Repo.update!()

    assert {:ok, claimed} =
             Encryption.claim_room_key_epoch(prepared.id, peer.id, "peer-device")

    assert claimed.fencing_token == prepared.fencing_token + 1

    [first | _] = cohorts

    assert {:error, :stale_fence} =
             Encryption.put_room_key_envelope(
               prepared.id,
               first.cohort.id,
               owner.id,
               "owner-device",
               prepared.fencing_token,
               envelope_attrs(first, 1)
             )

    Enum.with_index(cohorts, 1)
    |> Enum.each(fn {cohort, marker} ->
      attrs = envelope_attrs(cohort, marker)

      assert {:ok, stored} =
               Encryption.put_room_key_envelope(
                 prepared.id,
                 cohort.cohort.id,
                 peer.id,
                 "peer-device",
                 claimed.fencing_token,
                 attrs
               )

      assert {:ok, duplicate_envelope} =
               Encryption.put_room_key_envelope(
                 prepared.id,
                 cohort.cohort.id,
                 peer.id,
                 "peer-device",
                 claimed.fencing_token,
                 attrs
               )

      assert duplicate_envelope.id == stored.id
    end)

    assert {:ok, active} =
             Encryption.activate_room_key_epoch(
               prepared.id,
               peer.id,
               "peer-device",
               claimed.fencing_token
             )

    assert active.state == :active
    assert MapSet.new(active.envelopes, & &1.cohort_id) == MapSet.new(cohorts, & &1.cohort.id)

    assert {:ok, duplicate_activation} =
             Encryption.activate_room_key_epoch(
               prepared.id,
               peer.id,
               "peer-device",
               claimed.fencing_token
             )

    assert duplicate_activation.id == active.id

    assert {:ok, reported} =
             Encryption.report_room_key_epoch_repair(active.id, "local envelope unavailable")

    assert reported.state == :active
    assert reported.repair_reason == "local envelope unavailable"
    assert Encryption.get_active_room_key_epoch(room.id).id == active.id
  end

  test "missing or stale envelopes enter repair and wrapping rotation rewraps only its cohort" do
    %{owner: owner, room: room, cohorts: cohorts} = room_key_fixture()

    assert {:ok, prepared} =
             Encryption.prepare_room_key_epoch(
               room.id,
               owner.id,
               "owner-device",
               Ecto.UUID.generate(),
               "wrapping_key_rotation"
             )

    [rotated, unchanged] = cohorts

    assert {:ok, _} =
             Encryption.put_room_key_envelope(
               prepared.id,
               rotated.cohort.id,
               owner.id,
               "owner-device",
               prepared.fencing_token,
               envelope_attrs(rotated, 1)
             )

    assert {:error, :incomplete_envelopes} =
             Encryption.activate_room_key_epoch(
               prepared.id,
               owner.id,
               "owner-device",
               prepared.fencing_token
             )

    assert Encryption.get_room_key_epoch(prepared.id).state == :repair

    topology = Repo.get!(RoomTopology, rotated.cohort.topology_id)
    rotated_attrs = wrapping_attrs(rotated.cohort, topology, owner, 2, 9)
    assert {:ok, rotated_key} = Encryption.upsert_cohort_wrapping_key(rotated_attrs)
    assert rotated_key.mls_epoch == 2

    assert {:ok, rewrapped} =
             Encryption.put_room_key_envelope(
               prepared.id,
               rotated.cohort.id,
               owner.id,
               "owner-device",
               prepared.fencing_token,
               envelope_attrs(%{rotated | wrapping_key: rotated_key}, 3)
             )

    assert rewrapped.wrapping_mls_epoch == 2

    assert {:ok, unchanged_envelope} =
             Encryption.put_room_key_envelope(
               prepared.id,
               unchanged.cohort.id,
               owner.id,
               "owner-device",
               prepared.fencing_token,
               envelope_attrs(unchanged, 4)
             )

    assert unchanged_envelope.wrapping_mls_epoch == unchanged.wrapping_key.mls_epoch

    assert {:ok, active} =
             Encryption.activate_room_key_epoch(
               prepared.id,
               owner.id,
               "owner-device",
               prepared.fencing_token
             )

    assert active.state == :active

    assert Enum.find(active.envelopes, &(&1.cohort_id == rotated.cohort.id)).wrapping_mls_epoch ==
             2
  end

  test "retired room-key epochs are bounded by count" do
    %{owner: owner, room: room, cohorts: cohorts} = room_key_fixture()

    Enum.each(1..10, fn key_epoch ->
      assert {:ok, prepared} =
               Encryption.prepare_room_key_epoch(
                 room.id,
                 owner.id,
                 "owner-device",
                 Ecto.UUID.generate(),
                 "policy"
               )

      Enum.each(cohorts, fn cohort ->
        assert {:ok, _} =
                 Encryption.put_room_key_envelope(
                   prepared.id,
                   cohort.cohort.id,
                   owner.id,
                   "owner-device",
                   prepared.fencing_token,
                   envelope_attrs(cohort, key_epoch)
                 )
      end)

      assert {:ok, _} =
               Encryption.activate_room_key_epoch(
                 prepared.id,
                 owner.id,
                 "owner-device",
                 prepared.fencing_token
               )
    end)

    assert Repo.aggregate(
             from(epoch in Vesper.Encryption.RoomKeyEpoch,
               where: epoch.room_id == ^room.id and epoch.state == :retired
             ),
             :count
           ) == 8

    oldest =
      Repo.one!(
        from(epoch in Vesper.Encryption.RoomKeyEpoch,
          where: epoch.room_id == ^room.id and epoch.state == :retired,
          order_by: epoch.epoch,
          limit: 1
        )
      )

    oldest
    |> Ecto.Changeset.change(
      retained_until:
        DateTime.utc_now() |> DateTime.add(-1, :second) |> DateTime.truncate(:second)
    )
    |> Repo.update!()

    assert {:ok, %{scope_recovery_packages: 0, room_key_epochs: 1}} =
             Encryption.purge_expired_recovery_material()

    refute Repo.exists?(
             from(epoch in Vesper.Encryption.RoomKeyEpoch, where: epoch.id == ^oldest.id)
           )
  end

  test "populated room migration is idempotent and the durable cutover owns the scheme" do
    owner = insert_user()
    peer = insert_user()
    {:ok, server} = Servers.create_server(owner, %{name: "Populated migration"})
    {:ok, _} = Servers.join_server(peer, server.invite_code)
    channel = Enum.find(server.channels, &(&1.type == "text"))
    room = Runtime.get_room_for_channel(channel.id)

    assert {:ok, %Message{} = legacy_message} =
             Chat.create_message(%{
               ciphertext: <<1, 2, 3>>,
               mls_epoch: 1,
               encryption_scheme: "mls",
               channel_id: channel.id,
               sender_id: owner.id,
               client_nonce: "legacy-before-cutover"
             })

    assert {:ok, active_single} = Encryption.ensure_room_topology(room.id)
    assert active_single.mode == :single

    assert {:ok, preparing} =
             Encryption.prepare_room_topology(
               room.id,
               :multi_cohort,
               2,
               "migration-request-1"
             )

    assert {:ok, duplicate} =
             Encryption.prepare_room_topology(
               room.id,
               :multi_cohort,
               2,
               "migration-request-1"
             )

    assert duplicate.id == preparing.id

    assert {:ok, cohorts_ready} =
             Encryption.prepare_room_topology_members(preparing.id, [owner.id, peer.id])

    assert cohorts_ready.state == :cohorts_ready
    assert Encryption.get_effective_room_topology(room.id).id == active_single.id

    assert {:ok, topology, cohorts} =
             Encryption.get_room_key_coordination_material(room.id, preparing.id)

    Enum.with_index(cohorts, 1)
    |> Enum.each(fn {%{cohort: cohort}, marker} ->
      assert {:ok, _} =
               Encryption.upsert_cohort_wrapping_key(
                 wrapping_attrs(cohort, topology, owner, 1, marker)
               )
    end)

    assert {:ok, _topology, cohorts} =
             Encryption.get_room_key_coordination_material(room.id, preparing.id)

    assert {:ok, key_epoch} =
             Encryption.prepare_room_key_epoch(
               room.id,
               owner.id,
               "migration-device",
               "migration-room-key-1",
               "topology_change",
               preparing.id
             )

    Enum.with_index(cohorts, 1)
    |> Enum.each(fn {cohort, marker} ->
      assert {:ok, _} =
               Encryption.put_room_key_envelope(
                 key_epoch.id,
                 cohort.cohort.id,
                 owner.id,
                 "migration-device",
                 key_epoch.fencing_token,
                 envelope_attrs(cohort, marker)
               )
    end)

    assert {:ok, staged} =
             Encryption.stage_room_key_epoch(
               key_epoch.id,
               owner.id,
               "migration-device",
               key_epoch.fencing_token
             )

    assert staged.state == :staged

    assert {:ok, room_key_ready} =
             Encryption.mark_room_topology_key_ready(preparing.id, staged.id)

    assert room_key_ready.state == :room_key_ready

    assert {:error, {:projection_failed, :encryption_scheme_mismatch}} =
             Chat.create_message(%{
               ciphertext: <<4, 5, 6>>,
               mls_epoch: staged.epoch,
               encryption_scheme: "vesper-room-v1",
               channel_id: channel.id,
               sender_id: owner.id,
               client_nonce: "room-before-cutover"
             })

    assert {:ok, cutover} = Encryption.append_room_topology_cutover(room.id, preparing.id)
    assert cutover.state == :cutover_appended
    assert cutover.cutover_room_seq == legacy_message.room_seq + 1
    assert Encryption.get_effective_room_topology(room.id).id == preparing.id
    assert Encryption.get_active_room_key_epoch(room.id).id == staged.id

    assert {:ok, post_cutover_message} =
             Chat.create_message(%{
               ciphertext: <<7, 8, 9>>,
               mls_epoch: staged.epoch,
               encryption_scheme: "vesper-room-v1",
               channel_id: channel.id,
               sender_id: owner.id,
               client_nonce: "room-after-cutover"
             })

    assert {:error, {:projection_failed, :legacy_scheme_retired}} =
             Chat.create_message(%{
               ciphertext: <<10, 11, 12>>,
               mls_epoch: 2,
               encryption_scheme: "mls",
               channel_id: channel.id,
               sender_id: owner.id,
               client_nonce: "legacy-after-cutover"
             })

    assert {:ok, active} = Encryption.finalize_room_topology_cutover(room.id, preparing.id)
    assert active.state == :active
    assert {:ok, same_active} = Encryption.finalize_room_topology_cutover(room.id, preparing.id)
    assert same_active.id == active.id
    assert {:ok, same_cutover} = Encryption.append_room_topology_cutover(room.id, preparing.id)
    assert same_cutover.cutover_room_seq == cutover.cutover_room_seq

    events =
      Repo.all(
        from(event in RoomEvent,
          where: event.room_id == ^room.id,
          order_by: event.room_seq
        )
      )

    assert Enum.count(events, &(&1.event_type == "vesper.topology_cutover")) == 1
    assert Repo.get!(Message, legacy_message.id).encryption_scheme == "mls"
    assert Repo.get!(Message, post_cutover_message.id).encryption_scheme == "vesper-room-v1"
    assert Repo.get_by!(RoomEvent, message_id: legacy_message.id).encryption_algorithm == "mls"

    assert Repo.get_by!(RoomEvent, message_id: post_cutover_message.id).encryption_algorithm ==
             "vesper-room-v1"
  end

  test "failed preparation rolls back without changing the populated room scheme" do
    owner = insert_user()
    {:ok, server} = Servers.create_server(owner, %{name: "Migration rollback"})
    channel = Enum.find(server.channels, &(&1.type == "text"))
    room = Runtime.get_room_for_channel(channel.id)

    assert {:ok, _message} =
             Chat.create_message(%{
               ciphertext: <<1>>,
               mls_epoch: 1,
               encryption_scheme: "mls",
               channel_id: channel.id,
               sender_id: owner.id
             })

    assert {:ok, original} = Encryption.ensure_room_topology(room.id)

    assert {:ok, preparing} =
             Encryption.prepare_room_topology(room.id, :multi_cohort, 2, "rollback-request")

    assert {:ok, _} = Encryption.prepare_room_topology_members(preparing.id, [owner.id])

    assert {:ok, rolled_back} =
             Encryption.rollback_preparing_room_topology(
               room.id,
               preparing.id,
               "injected_failure"
             )

    assert rolled_back.state == :rolled_back
    assert rolled_back.failure_reason == "injected_failure"
    assert Encryption.get_effective_room_topology(room.id).id == original.id
    assert :ok == Encryption.validate_application_scheme(room.id, "mls", 2)

    assert {:error, :encryption_scheme_mismatch} ==
             Encryption.validate_application_scheme(room.id, "vesper-room-v1", 1)
  end

  defp room_key_fixture do
    owner = insert_user()
    peer = insert_user()
    third = insert_user()
    {:ok, server} = Servers.create_server(owner, %{name: "Room key coordination"})
    {:ok, _} = Servers.join_server(peer, server.invite_code)
    {:ok, _} = Servers.join_server(third, server.invite_code)
    channel = Enum.find(server.channels, &(&1.type == "text"))
    room = Runtime.get_room_for_channel(channel.id)

    assert {:ok, _} = Encryption.ensure_room_topology(room.id)
    assert {:ok, preparing} = Encryption.prepare_room_topology(room.id, :multi_cohort, 2)
    assert {:ok, _} = Encryption.activate_room_topology(preparing.id, room.current_seq)
    assert {:ok, _} = Encryption.resolve_room_topology(room.id, owner.id)
    assert {:ok, _} = Encryption.resolve_room_topology(room.id, peer.id)
    assert {:ok, _} = Encryption.resolve_room_topology(room.id, third.id)
    assert {:ok, topology, cohorts} = Encryption.get_room_key_coordination_material(room.id)

    Enum.with_index(cohorts, 1)
    |> Enum.each(fn {%{cohort: cohort}, marker} ->
      assert {:ok, _wrapping_key} =
               Encryption.upsert_cohort_wrapping_key(
                 wrapping_attrs(cohort, topology, owner, 1, marker)
               )
    end)

    assert {:ok, _topology, cohorts} = Encryption.get_room_key_coordination_material(room.id)
    %{owner: owner, peer: peer, room: room, cohorts: cohorts}
  end

  defp wrapping_attrs(cohort, topology, owner, mls_epoch, marker) do
    %{
      group_id: cohort.group_id,
      room_id: topology.room_id,
      cohort_id: cohort.id,
      topology_generation: topology.generation,
      mls_epoch: mls_epoch,
      public_key: :binary.copy(<<marker>>, 32),
      signature: :binary.copy(<<marker + 1>>, 64),
      signer_identity: "#{owner.id}:owner-device",
      signer_public_key: :binary.copy(<<marker + 2>>, 32),
      group_info_digest: :binary.copy(<<marker + 3>>, 32),
      publisher_id: owner.id,
      publisher_device_id: "owner-device"
    }
  end

  defp envelope_attrs(%{cohort: cohort, wrapping_key: wrapping_key}, marker) do
    %{
      group_id: cohort.group_id,
      wrapping_mls_epoch: wrapping_key.mls_epoch,
      ephemeral_public_key: :binary.copy(<<marker>>, 32),
      nonce: :binary.copy(<<marker + 1>>, 12),
      ciphertext: :binary.copy(<<marker + 2>>, 48),
      aad_digest: :binary.copy(<<marker + 3>>, 32)
    }
  end
end
