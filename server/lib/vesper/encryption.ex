defmodule Vesper.Encryption do
  @moduledoc """
  Context for MLS key package directory and pending Welcome storage.
  The server is a dumb relay — it stores encrypted blobs without access to plaintext.
  """

  import Ecto.Query
  require Logger
  alias Vesper.Dispatch
  alias Vesper.Repo
  alias Vesper.Servers.Membership

  alias Vesper.Encryption.{
    CohortWrappingKey,
    ControlOperation,
    KeyPackage,
    MlsEvent,
    MlsGroupInfo,
    PendingCryptoEviction,
    PendingHistoryBundle,
    PendingHistoryRequest,
    PendingResyncRequest,
    PendingWelcome,
    RoomCohort,
    RoomCohortMembership,
    RoomKeyEnvelope,
    RoomKeyEpoch,
    RoomTopology,
    ScopeRecoveryPackage
  }

  alias Vesper.Runtime.{Room, RoomEvent}

  # Maximum allowed epoch jump for non-CAS GroupInfo publishes.
  # Prevents a compromised client from inflating the epoch to block others.
  @max_epoch_delta 1000
  @sponsor_lease_seconds 15
  @room_key_lease_seconds 15
  @room_key_retention_seconds 7 * 24 * 60 * 60
  @max_retired_room_key_epochs 8

  @doc """
  Runs one durable control operation under a scope- and actor-bound idempotency key.

  The reservation and the callback's database writes share one transaction. A
  duplicate with the same canonical payload returns the original result; a key
  reused for different bytes is rejected before the callback can mutate state.
  """
  def run_control_operation(attrs, payload, operation) when is_function(operation, 0) do
    payload_hash = control_payload_hash(payload)
    now = DateTime.utc_now() |> DateTime.truncate(:second)
    id = Ecto.UUID.generate()

    reservation = %{
      id: id,
      actor_id: attrs.actor_id,
      actor_client_id: attrs.actor_client_id,
      scope_kind: attrs.scope_kind,
      scope_id: attrs.scope_id,
      operation: attrs.operation,
      idempotency_key: attrs.idempotency_key,
      payload_hash: payload_hash,
      state: "pending",
      inserted_at: now,
      updated_at: now
    }

    conflict_target = [
      :actor_id,
      :actor_client_id,
      :scope_kind,
      :scope_id,
      :operation,
      :idempotency_key
    ]

    Repo.transaction(fn ->
      case Repo.insert_all(ControlOperation, [reservation],
             on_conflict: :nothing,
             conflict_target: conflict_target
           ) do
        {1, _} ->
          case operation.() do
            {:ok, result} when is_map(result) ->
              from(entry in ControlOperation, where: entry.id == ^id)
              |> Repo.update_all(set: [state: "accepted", result: result, updated_at: now])

              {:new, result}

            {:error, reason} ->
              Repo.rollback(reason)
          end

        {0, _} ->
          existing =
            from(entry in ControlOperation,
              where:
                entry.actor_id == ^attrs.actor_id and
                  entry.actor_client_id == ^attrs.actor_client_id and
                  entry.scope_kind == ^attrs.scope_kind and
                  entry.scope_id == ^attrs.scope_id and
                  entry.operation == ^attrs.operation and
                  entry.idempotency_key == ^attrs.idempotency_key
            )
            |> Repo.one!()

          cond do
            existing.payload_hash != payload_hash ->
              Repo.rollback(:idempotency_conflict)

            existing.state == "accepted" and is_map(existing.result) ->
              {:duplicate, existing.result}

            true ->
              Repo.rollback(:incomplete_control_operation)
          end
      end
    end)
    |> case do
      {:ok, {status, result}} -> {:ok, result, status}
      {:error, reason} -> {:error, reason}
    end
  end

  defp control_payload_hash(payload) do
    payload
    |> canonical_control_term()
    |> :erlang.term_to_binary([:deterministic])
    |> then(&:crypto.hash(:sha256, &1))
  end

  defp canonical_control_term(value) when is_map(value) do
    value
    |> Enum.map(fn {key, item} -> {to_string(key), canonical_control_term(item)} end)
    |> Enum.sort_by(&elem(&1, 0))
  end

  defp canonical_control_term(value) when is_list(value),
    do: Enum.map(value, &canonical_control_term/1)

  defp canonical_control_term(value), do: value

  # --- Key Packages ---

  @doc """
  Bulk-insert key packages for a user.
  """
  def upload_key_packages(user_id, client_id, packages) when is_list(packages) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    entries =
      Enum.map(packages, fn data ->
        %{
          id: Ecto.UUID.generate(),
          user_id: user_id,
          client_id: client_id,
          key_package_data: data,
          consumed: false,
          inserted_at: now
        }
      end)

    Repo.insert_all(KeyPackage, entries)
  end

  @doc """
  Fetch one unconsumed key package for a user and mark it consumed atomically.
  Returns nil if no packages available.
  """
  def fetch_and_consume_key_package(user_id, client_id \\ nil) do
    Repo.transaction(fn ->
      query =
        if is_binary(client_id) and byte_size(client_id) > 0 do
          from(kp in KeyPackage,
            where: kp.user_id == ^user_id and kp.client_id == ^client_id and kp.consumed == false,
            order_by: [asc: kp.inserted_at],
            limit: 1,
            lock: "FOR UPDATE SKIP LOCKED"
          )
        else
          from(kp in KeyPackage,
            where: kp.user_id == ^user_id and kp.consumed == false,
            order_by: [desc: kp.inserted_at],
            limit: 1,
            lock: "FOR UPDATE SKIP LOCKED"
          )
        end

      case Repo.one(query) do
        nil ->
          nil

        kp ->
          kp
          |> Ecto.Changeset.change(consumed: true)
          |> Repo.update!()

          kp.key_package_data
      end
    end)
    |> case do
      {:ok, result} -> result
      {:error, _} -> nil
    end
  end

  @doc """
  Count unconsumed key packages for a user.
  """
  def count_key_packages(user_id, client_id \\ nil) do
    query =
      from(kp in KeyPackage,
        where: kp.user_id == ^user_id and kp.consumed == false
      )

    query =
      if is_binary(client_id) and byte_size(client_id) > 0 do
        from(kp in query, where: kp.client_id == ^client_id)
      else
        query
      end

    from(kp in query,
      select: count()
    )
    |> Repo.one()
  end

  @doc """
  Mark a specific unconsumed key package as consumed, identified by its raw data.
  Used when a client consumes a key package locally (e.g. during group creation)
  and needs to synchronize that consumption with the server to prevent the stale
  package from being handed out to other clients via fetch_and_consume_key_package.
  """
  def consume_own_key_package(user_id, client_id, key_package_data)
      when is_binary(key_package_data) do
    query =
      from(kp in KeyPackage,
        where:
          kp.user_id == ^user_id and
            kp.client_id == ^client_id and
            kp.key_package_data == ^key_package_data and
            kp.consumed == false
      )

    case Repo.update_all(query, set: [consumed: true]) do
      {n, _} when n > 0 -> :ok
      {0, _} -> {:error, :not_found}
    end
  end

  @doc """
  Purge all unconsumed key packages for a user.
  Used when a new device is set up to remove stale packages from previous devices.
  """
  def purge_key_packages(user_id, client_id \\ nil) do
    query =
      from(kp in KeyPackage,
        where: kp.user_id == ^user_id and kp.consumed == false
      )

    query =
      if is_binary(client_id) and byte_size(client_id) > 0 do
        from(kp in query, where: kp.client_id == ^client_id)
      else
        query
      end

    Repo.delete_all(query)
  end

  @doc """
  Delete consumed key packages older than the given age.
  """
  def purge_consumed_key_packages(max_age_hours \\ 24) do
    cutoff =
      DateTime.utc_now()
      |> DateTime.add(-max_age_hours * 3600, :second)
      |> DateTime.truncate(:second)

    from(kp in KeyPackage,
      where: kp.consumed == true and kp.inserted_at < ^cutoff
    )
    |> Repo.delete_all()
  end

  # --- Pending Welcomes ---

  @doc """
  Store a pending Welcome message for an offline user.
  """
  def store_pending_welcome(attrs) do
    Repo.transaction(fn ->
      case upsert_pending_welcome(attrs) do
        {:ok, welcome} -> welcome
        {:error, reason} -> Repo.rollback(reason)
      end
    end)
    |> case do
      {:ok, welcome} -> {:ok, welcome}
      {:error, reason} -> {:error, reason}
    end
  end

  @doc """
  Get all pending Welcomes for a user in a specific MLS group scope.
  """
  def get_pending_welcomes(recipient_id, group_id, recipient_client_id \\ nil) do
    query =
      from(pw in PendingWelcome,
        where: pw.recipient_id == ^recipient_id and pw.group_id == ^group_id
      )

    query =
      if is_binary(recipient_client_id) and byte_size(recipient_client_id) > 0 do
        from(
          pw in query,
          where: pw.recipient_client_id == ^recipient_client_id or is_nil(pw.recipient_client_id)
        )
      else
        query
      end

    from(pw in query,
      order_by: [asc: pw.inserted_at]
    )
    |> Repo.all()
  end

  @doc """
  Get all pending Welcomes for a user (across all channels).
  """
  def get_all_pending_welcomes(recipient_id, recipient_client_id \\ nil) do
    query =
      from(pw in PendingWelcome,
        where: pw.recipient_id == ^recipient_id
      )

    query =
      if is_binary(recipient_client_id) and byte_size(recipient_client_id) > 0 do
        from(
          pw in query,
          where: pw.recipient_client_id == ^recipient_client_id or is_nil(pw.recipient_client_id)
        )
      else
        query
      end

    from(pw in query,
      order_by: [asc: pw.inserted_at]
    )
    |> Repo.all()
  end

  @doc """
  Get a single pending Welcome by id.
  """
  def get_pending_welcome(id) do
    Repo.get(PendingWelcome, id)
  end

  @doc """
  Delete a pending Welcome after it's been processed.
  """
  def delete_pending_welcome(id) do
    from(pw in PendingWelcome, where: pw.id == ^id)
    |> Repo.delete_all()
  end

  @doc """
  Delete all pending Welcomes older than the given age.
  """
  def purge_old_welcomes(max_age_hours \\ 24) do
    cutoff =
      DateTime.utc_now()
      |> DateTime.add(-max_age_hours * 3600, :second)
      |> DateTime.truncate(:second)

    from(pw in PendingWelcome,
      where: pw.inserted_at < ^cutoff
    )
    |> Repo.delete_all()
  end

  # --- Pending History Requests ---

  @doc """
  Store or refresh a pending same-user history request for an MLS scope.
  """
  def store_pending_history_request(attrs) do
    requester_username =
      Map.get(attrs, :requester_username) || Map.get(attrs, "requester_username")

    membership_generation =
      Map.get(attrs, :membership_generation) || Map.get(attrs, "membership_generation") || 0

    channel_id = Map.get(attrs, :channel_id) || Map.get(attrs, "channel_id")
    conversation_id = Map.get(attrs, :conversation_id) || Map.get(attrs, "conversation_id")

    attrs = Map.put(attrs, :membership_generation, membership_generation)

    %PendingHistoryRequest{}
    |> PendingHistoryRequest.changeset(attrs)
    |> Repo.insert(
      on_conflict: [
        set: [
          requester_username: requester_username,
          membership_generation: membership_generation,
          channel_id: channel_id,
          conversation_id: conversation_id,
          inserted_at: DateTime.utc_now() |> DateTime.truncate(:second)
        ]
      ],
      conflict_target: [:group_id, :requester_id, :requester_client_id]
    )
  end

  @doc """
  Get all pending same-user history requests for a specific MLS group scope.
  """
  def get_pending_history_requests(group_id) do
    from(pr in PendingHistoryRequest,
      where: pr.group_id == ^group_id,
      order_by: [asc: pr.inserted_at]
    )
    |> Repo.all()
  end

  @doc """
  Get a single pending same-user history request by id.
  """
  def get_pending_history_request(id) do
    Repo.get(PendingHistoryRequest, id)
  end

  @doc """
  Delete a pending same-user history request after it has been handled.
  """
  def delete_pending_history_request(id) do
    from(pr in PendingHistoryRequest, where: pr.id == ^id)
    |> Repo.delete_all()
  end

  # --- Pending History Bundles ---

  @doc """
  Store or refresh a pending same-user history bundle for a recipient device.
  """
  def store_pending_history_bundle(attrs) do
    ciphertext = Map.get(attrs, :ciphertext) || Map.get(attrs, "ciphertext")
    mls_epoch = Map.get(attrs, :mls_epoch) || Map.get(attrs, "mls_epoch")

    channel_id = Map.get(attrs, :channel_id) || Map.get(attrs, "channel_id")
    conversation_id = Map.get(attrs, :conversation_id) || Map.get(attrs, "conversation_id")

    %PendingHistoryBundle{}
    |> PendingHistoryBundle.changeset(attrs)
    |> Repo.insert(
      on_conflict: [
        set: [
          ciphertext: ciphertext,
          mls_epoch: mls_epoch,
          channel_id: channel_id,
          conversation_id: conversation_id,
          inserted_at: DateTime.utc_now() |> DateTime.truncate(:second)
        ]
      ],
      conflict_target: [:group_id, :recipient_id, :recipient_client_id, :sender_id]
    )
  end

  @doc """
  Get all pending same-user history bundles for a specific MLS scope and device.
  """
  def get_pending_history_bundles(recipient_id, group_id, recipient_client_id \\ nil) do
    query =
      from(pb in PendingHistoryBundle,
        where: pb.group_id == ^group_id and pb.recipient_id == ^recipient_id,
        order_by: [asc: pb.inserted_at]
      )

    query =
      if is_binary(recipient_client_id) and byte_size(recipient_client_id) > 0 do
        from(pb in query, where: pb.recipient_client_id == ^recipient_client_id)
      else
        query
      end

    Repo.all(query)
  end

  @doc """
  Get a single pending same-user history bundle by id.
  """
  def get_pending_history_bundle(id) do
    Repo.get(PendingHistoryBundle, id)
  end

  @doc """
  Delete a pending same-user history bundle after it has been consumed.
  """
  def delete_pending_history_bundle(id) do
    from(pb in PendingHistoryBundle, where: pb.id == ^id)
    |> Repo.delete_all()
  end

  # --- Durable room crypto topology ---

  @default_cohort_size 512

  @pre_cutover_states [:preparing, :cohorts_ready, :room_key_ready]
  @effective_topology_states [:cutover_appended, :active]

  def get_active_room_topology(room_id) do
    Repo.one(
      from(topology in RoomTopology,
        where: topology.room_id == ^room_id and topology.state == :active,
        preload: [:cohorts]
      )
    )
  end

  def get_effective_room_topology(room_id) do
    Repo.one(
      from(topology in RoomTopology,
        where: topology.room_id == ^room_id and topology.state in ^@effective_topology_states,
        order_by: [desc: topology.generation],
        limit: 1,
        preload: [:cohorts]
      )
    )
  end

  def validate_application_scheme(room_id, scheme, epoch, group_id \\ nil) do
    topology = get_effective_room_topology(room_id)

    case {scheme, topology} do
      {"mls", nil} ->
        :ok

      {"mls", %RoomTopology{mode: mode}} when mode in [:single, :batched_single] ->
        room = Repo.get!(Room, room_id)

        if is_nil(group_id) or group_id == canonical_room_group_id(room),
          do: :ok,
          else: {:error, :encryption_group_mismatch}

      {"vesper-room-v1", %RoomTopology{mode: :multi_cohort}} ->
        case get_active_room_key_epoch(room_id) do
          %RoomKeyEpoch{epoch: ^epoch} -> :ok
          _ -> {:error, :room_key_epoch_mismatch}
        end

      {"mls", %RoomTopology{mode: :multi_cohort}} ->
        {:error, :legacy_scheme_retired}

      _ ->
        {:error, :encryption_scheme_mismatch}
    end
  end

  def ensure_room_topology(room_id) do
    Repo.transaction(fn ->
      room = lock_room!(room_id)

      case effective_room_topology_for_update(room.id) do
        nil -> insert_default_topology!(room) |> Repo.preload(:cohorts)
        topology -> Repo.preload(topology, :cohorts)
      end
    end)
    |> unwrap_transaction_result()
  end

  def prepare_room_topology(room_id, mode, target_cohort_size)
      when mode in [:single, :batched_single, :multi_cohort] do
    prepare_room_topology(room_id, mode, target_cohort_size, Ecto.UUID.generate())
  end

  def prepare_room_topology(room_id, mode, target_cohort_size, request_id)
      when mode in [:single, :batched_single, :multi_cohort] and is_binary(request_id) do
    Repo.transaction(fn ->
      room = lock_room!(room_id)
      current = effective_room_topology_for_update(room.id) || insert_default_topology!(room)

      case Repo.one(
             from(topology in RoomTopology,
               where: topology.room_id == ^room.id and topology.request_id == ^request_id,
               lock: "FOR UPDATE"
             )
           ) do
        %RoomTopology{} = existing ->
          if existing.mode == mode and existing.target_cohort_size == target_cohort_size do
            Repo.preload(existing, :cohorts)
          else
            Repo.rollback(:request_conflict)
          end

        nil ->
          if Repo.exists?(
               from(topology in RoomTopology,
                 where: topology.room_id == ^room.id and topology.state in ^@pre_cutover_states
               )
             ) do
            Repo.rollback(:migration_in_progress)
          end

          %RoomTopology{}
          |> RoomTopology.changeset(%{
            room_id: room.id,
            mode: mode,
            generation: next_topology_generation(room.id),
            target_cohort_size: target_cohort_size,
            state: :preparing,
            request_id: request_id,
            previous_topology_id: current.id
          })
          |> Repo.insert!()
          |> Repo.preload(:cohorts)
      end
    end)
    |> unwrap_transaction_result()
  end

  def prepare_room_topology_members(topology_id, user_ids) when is_list(user_ids) do
    Repo.transaction(fn ->
      topology = lock_room_topology!(topology_id)

      if topology.state not in [:preparing, :cohorts_ready] do
        Repo.rollback(:topology_not_preparing)
      end

      user_ids
      |> Enum.filter(&is_binary/1)
      |> Enum.uniq()
      |> Enum.sort()
      |> Enum.each(&assign_user_to_cohort!(topology, &1))

      topology
      |> RoomTopology.changeset(%{state: :cohorts_ready, failure_reason: nil})
      |> Repo.update!()
      |> Repo.preload(:cohorts, force: true)
    end)
    |> unwrap_transaction_result()
  end

  def mark_room_topology_key_ready(topology_id, room_key_epoch_id) do
    Repo.transaction(fn ->
      topology = lock_room_topology!(topology_id)
      epoch = lock_room_key_epoch!(room_key_epoch_id)

      cond do
        topology.state == :room_key_ready and epoch.state == :staged ->
          topology

        topology.state != :cohorts_ready ->
          Repo.rollback(:cohorts_not_ready)

        epoch.topology_id != topology.id or epoch.topology_generation != topology.generation ->
          Repo.rollback(:topology_changed)

        epoch.state != :staged ->
          Repo.rollback(:room_key_not_staged)

        true ->
          topology
          |> RoomTopology.changeset(%{state: :room_key_ready, failure_reason: nil})
          |> Repo.update!()
      end
    end)
    |> unwrap_transaction_result()
  end

  def append_room_topology_cutover(room_id, topology_id) do
    Repo.transaction(fn ->
      topology = lock_room_topology!(room_id, topology_id)

      if topology.state in [:cutover_appended, :active] do
        topology
      else
        if topology.state != :room_key_ready do
          Repo.rollback(:room_key_not_ready)
        end

        room = lock_room!(topology.room_id)
        staged_epoch = staged_room_key_epoch!(topology)
        room_seq = room.current_seq + 1
        now = DateTime.utc_now() |> DateTime.truncate(:second)
        payload = topology_cutover_payload(topology, staged_epoch, room_seq)

        event =
          %RoomEvent{}
          |> RoomEvent.changeset(%{
            room_id: room.id,
            room_seq: room_seq,
            event_type: "vesper.topology_cutover",
            content: payload
          })
          |> Repo.insert!()

        room
        |> Room.changeset(%{
          current_seq: room_seq,
          last_mutation_seq: room_seq,
          last_mutation_at: now
        })
        |> Repo.update!()

        {:ok, _dispatch} = enqueue_topology_cutover_dispatch(room, event, payload)

        topology
        |> RoomTopology.changeset(%{
          state: :cutover_appended,
          cutover_room_seq: room_seq,
          failure_reason: nil
        })
        |> Repo.update!()
      end
    end)
    |> unwrap_transaction_result()
  end

  def finalize_room_topology_cutover(room_id, topology_id) do
    Repo.transaction(fn ->
      topology = lock_room_topology!(room_id, topology_id)

      if topology.state == :active do
        topology
      else
        if topology.state != :cutover_appended do
          Repo.rollback(:cutover_not_appended)
        end

        now = DateTime.utc_now() |> DateTime.truncate(:second)
        staged_epoch = staged_room_key_epoch!(topology)

        from(item in RoomTopology,
          where:
            item.room_id == ^topology.room_id and item.id != ^topology.id and
              item.state == :active
        )
        |> Repo.update_all(set: [state: :retired, retired_at: now, updated_at: now])

        from(epoch in RoomKeyEpoch,
          where:
            epoch.room_id == ^topology.room_id and epoch.id != ^staged_epoch.id and
              epoch.state == :active
        )
        |> Repo.update_all(
          set: [
            state: :retired,
            retained_until: DateTime.add(now, @room_key_retention_seconds, :second),
            updated_at: now
          ]
        )

        staged_epoch
        |> RoomKeyEpoch.changeset(%{state: :active, activated_at: now})
        |> Repo.update!()

        topology
        |> RoomTopology.changeset(%{state: :active, activated_at: now})
        |> Repo.update!()
      end
    end)
    |> unwrap_transaction_result()
  end

  def activate_room_topology(topology_id, cutover_room_seq) when is_integer(cutover_room_seq) do
    Repo.transaction(fn ->
      topology = lock_room_topology!(topology_id)

      if topology.state != :preparing do
        Repo.rollback(:topology_not_preparing)
      end

      room = lock_room!(topology.room_id)

      if room.current_seq != 0 or cutover_room_seq != room.current_seq do
        Repo.rollback(:migration_required)
      end

      now = DateTime.utc_now() |> DateTime.truncate(:second)

      from(item in RoomTopology,
        where: item.room_id == ^topology.room_id and item.state == :active
      )
      |> Repo.update_all(set: [state: :retired, retired_at: now, updated_at: now])

      topology
      |> RoomTopology.changeset(%{
        state: :active,
        cutover_room_seq: cutover_room_seq,
        activated_at: now
      })
      |> Repo.update!()
    end)
    |> unwrap_transaction_result()
  end

  def rollback_preparing_room_topology(room_id, topology_id, reason \\ "preparation_failed") do
    Repo.transaction(fn ->
      topology = lock_room_topology!(room_id, topology_id)

      if topology.state not in @pre_cutover_states do
        Repo.rollback(:topology_not_preparing)
      end

      from(epoch in RoomKeyEpoch,
        where: epoch.topology_id == ^topology.id and epoch.state in [:preparing, :staged, :repair]
      )
      |> Repo.update_all(
        set: [
          state: :retired,
          retained_until: DateTime.utc_now() |> DateTime.truncate(:second),
          updated_at: DateTime.utc_now() |> DateTime.truncate(:second)
        ]
      )

      topology
      |> RoomTopology.changeset(%{
        state: :rolled_back,
        failure_reason: String.slice(reason, 0, 255)
      })
      |> Repo.update!()
    end)
    |> unwrap_transaction_result()
  end

  def resolve_room_topology(room_id, user_id) do
    Repo.transaction(fn ->
      room = lock_room!(room_id)
      topology = effective_room_topology_for_update(room.id) || insert_default_topology!(room)

      topology_resolution(room, topology, user_id)
    end)
    |> unwrap_transaction_result()
  end

  def resolve_room_topology_generation(room_id, topology_id, user_id) do
    Repo.transaction(fn ->
      topology = lock_room_topology!(room_id, topology_id)

      if topology.state in [:retired, :rolled_back] do
        Repo.rollback(:topology_unavailable)
      end

      room = lock_room!(topology.room_id)
      topology_resolution(room, topology, user_id)
    end)
    |> unwrap_transaction_result()
  end

  def get_cohort_wrapping_key(group_id), do: Repo.get_by(CohortWrappingKey, group_id: group_id)

  def upsert_cohort_wrapping_key(attrs) do
    Repo.transaction(fn ->
      existing =
        Repo.one(
          from(key in CohortWrappingKey,
            where: key.group_id == ^attrs.group_id,
            lock: "FOR UPDATE"
          )
        )

      case existing do
        nil ->
          %CohortWrappingKey{}
          |> CohortWrappingKey.changeset(attrs)
          |> Repo.insert!()

        key when attrs.mls_epoch < key.mls_epoch ->
          Repo.rollback(:epoch_conflict)

        key when attrs.mls_epoch == key.mls_epoch ->
          if same_wrapping_publication?(key, attrs) do
            key
          else
            Repo.rollback(:epoch_conflict)
          end

        key ->
          key
          |> CohortWrappingKey.changeset(attrs)
          |> Repo.update!()
      end
    end)
    |> unwrap_transaction_result()
  end

  defp same_wrapping_publication?(key, attrs) do
    key.public_key == attrs.public_key and key.signature == attrs.signature and
      key.signer_identity == attrs.signer_identity and
      key.signer_public_key == attrs.signer_public_key and
      key.group_info_digest == attrs.group_info_digest and
      key.topology_generation == attrs.topology_generation
  end

  # --- Fenced room data-key coordination ---

  def prepare_room_key_epoch(
        room_id,
        coordinator_user_id,
        coordinator_device_id,
        request_id,
        reason
      ) do
    prepare_room_key_epoch(
      room_id,
      coordinator_user_id,
      coordinator_device_id,
      request_id,
      reason,
      nil
    )
  end

  def prepare_room_key_epoch(
        room_id,
        coordinator_user_id,
        coordinator_device_id,
        request_id,
        reason,
        topology_id
      ) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    Repo.transaction(fn ->
      _room = lock_room!(room_id)
      topology = room_key_topology_for_update(room_id, topology_id)

      if is_nil(topology) or topology.mode != :multi_cohort or
           topology.state not in [:active, :cohorts_ready, :room_key_ready] do
        Repo.rollback(:multi_cohort_topology_required)
      end

      case Repo.one(
             from(epoch in RoomKeyEpoch,
               where: epoch.room_id == ^room_id and epoch.request_id == ^request_id,
               lock: "FOR UPDATE"
             )
           ) do
        %RoomKeyEpoch{} = existing ->
          if existing.coordinator_user_id == coordinator_user_id and
               existing.coordinator_device_id == coordinator_device_id and
               existing.topology_id == topology.id do
            Repo.preload(existing, :envelopes)
          else
            Repo.rollback(:request_conflict)
          end

        nil ->
          if Repo.exists?(
               from(epoch in RoomKeyEpoch,
                 where:
                   epoch.room_id == ^room_id and epoch.state in [:preparing, :staged, :repair]
               )
             ) do
            Repo.rollback(:coordination_in_progress)
          end

          cohorts = active_room_key_cohorts(topology.id)

          if cohorts == [] do
            Repo.rollback(:no_active_cohorts)
          end

          if Enum.any?(cohorts, &is_nil(&1.wrapping_key)) do
            Repo.rollback(:wrapping_keys_incomplete)
          end

          %RoomKeyEpoch{}
          |> RoomKeyEpoch.changeset(%{
            room_id: room_id,
            topology_id: topology.id,
            topology_generation: topology.generation,
            epoch: next_room_key_epoch(room_id),
            state: :preparing,
            reason: reason,
            request_id: request_id,
            fencing_token: next_room_key_fence(room_id),
            coordinator_user_id: coordinator_user_id,
            coordinator_device_id: coordinator_device_id,
            expected_cohort_count: length(cohorts),
            lease_expires_at: DateTime.add(now, @room_key_lease_seconds, :second)
          })
          |> Repo.insert!()
          |> Repo.preload(:envelopes)
      end
    end)
    |> unwrap_transaction_result()
  end

  def claim_room_key_epoch(epoch_id, coordinator_user_id, coordinator_device_id) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    Repo.transaction(fn ->
      epoch = lock_room_key_epoch!(epoch_id)

      if epoch.state not in [:preparing, :repair] do
        Repo.rollback(:not_claimable)
      end

      same_coordinator =
        epoch.coordinator_user_id == coordinator_user_id and
          epoch.coordinator_device_id == coordinator_device_id

      lease_live =
        epoch.lease_expires_at && DateTime.compare(epoch.lease_expires_at, now) == :gt

      cond do
        same_coordinator and lease_live ->
          Repo.preload(epoch, :envelopes)

        not same_coordinator and lease_live ->
          Repo.rollback(:lease_held)

        true ->
          claimant_membership =
            Repo.get_by(RoomCohortMembership,
              topology_id: epoch.topology_id,
              user_id: coordinator_user_id
            ) || Repo.rollback(:cohort_assignment_required)

          has_claimant_envelope =
            Repo.exists?(
              from(envelope in RoomKeyEnvelope,
                where:
                  envelope.room_key_epoch_id == ^epoch.id and
                    envelope.cohort_id == ^claimant_membership.cohort_id
              )
            )

          if not has_claimant_envelope do
            Repo.delete_all(
              from(envelope in RoomKeyEnvelope, where: envelope.room_key_epoch_id == ^epoch.id)
            )
          end

          epoch
          |> RoomKeyEpoch.changeset(%{
            coordinator_user_id: coordinator_user_id,
            coordinator_device_id: coordinator_device_id,
            fencing_token: epoch.fencing_token + 1,
            lease_expires_at: DateTime.add(now, @room_key_lease_seconds, :second)
          })
          |> Repo.update!()
          |> Repo.preload(:envelopes, force: true)
      end
    end)
    |> unwrap_transaction_result()
  end

  def renew_room_key_epoch(epoch_id, coordinator_user_id, coordinator_device_id, fencing_token) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    Repo.transaction(fn ->
      epoch = lock_room_key_epoch!(epoch_id)

      assert_room_key_coordinator!(
        epoch,
        coordinator_user_id,
        coordinator_device_id,
        fencing_token,
        now
      )

      epoch
      |> RoomKeyEpoch.changeset(%{
        lease_expires_at: DateTime.add(now, @room_key_lease_seconds, :second)
      })
      |> Repo.update!()
    end)
    |> unwrap_transaction_result()
  end

  def put_room_key_envelope(
        epoch_id,
        cohort_id,
        coordinator_user_id,
        coordinator_device_id,
        fencing_token,
        attrs
      ) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    Repo.transaction(fn ->
      epoch = lock_room_key_epoch!(epoch_id)

      assert_room_key_coordinator!(
        epoch,
        coordinator_user_id,
        coordinator_device_id,
        fencing_token,
        now
      )

      if epoch.state not in [:preparing, :repair] do
        Repo.rollback(:epoch_not_open)
      end

      cohort =
        Repo.one(
          from(cohort in RoomCohort,
            where:
              cohort.id == ^cohort_id and cohort.topology_id == ^epoch.topology_id and
                cohort.state == :active,
            lock: "FOR UPDATE"
          )
        ) || Repo.rollback(:invalid_cohort)

      wrapping_key =
        Repo.get_by(CohortWrappingKey, cohort_id: cohort.id) ||
          Repo.rollback(:wrapping_key_missing)

      if attrs.group_id != cohort.group_id or attrs.wrapping_mls_epoch != wrapping_key.mls_epoch do
        Repo.rollback(:stale_wrapping_key)
      end

      envelope_attrs =
        attrs
        |> Map.put(:room_key_epoch_id, epoch.id)
        |> Map.put(:cohort_id, cohort.id)

      case Repo.get_by(RoomKeyEnvelope, room_key_epoch_id: epoch.id, cohort_id: cohort.id) do
        nil ->
          %RoomKeyEnvelope{}
          |> RoomKeyEnvelope.changeset(envelope_attrs)
          |> Repo.insert!()

        existing when attrs.wrapping_mls_epoch < existing.wrapping_mls_epoch ->
          Repo.rollback(:stale_wrapping_key)

        existing when attrs.wrapping_mls_epoch == existing.wrapping_mls_epoch ->
          if same_room_key_envelope?(existing, envelope_attrs) do
            existing
          else
            Repo.rollback(:envelope_conflict)
          end

        existing ->
          existing
          |> RoomKeyEnvelope.changeset(envelope_attrs)
          |> Repo.update!()
      end
    end)
    |> unwrap_transaction_result()
  end

  def activate_room_key_epoch(
        epoch_id,
        coordinator_user_id,
        coordinator_device_id,
        fencing_token
      ) do
    complete_room_key_epoch(
      epoch_id,
      coordinator_user_id,
      coordinator_device_id,
      fencing_token,
      :active
    )
  end

  def stage_room_key_epoch(
        epoch_id,
        coordinator_user_id,
        coordinator_device_id,
        fencing_token
      ) do
    complete_room_key_epoch(
      epoch_id,
      coordinator_user_id,
      coordinator_device_id,
      fencing_token,
      :staged
    )
  end

  defp complete_room_key_epoch(
         epoch_id,
         coordinator_user_id,
         coordinator_device_id,
         fencing_token,
         target_state
       )
       when target_state in [:active, :staged] do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    Repo.transaction(fn ->
      epoch = lock_room_key_epoch!(epoch_id) |> Repo.preload(:envelopes)

      if epoch.state == target_state do
        if epoch.coordinator_user_id == coordinator_user_id and
             epoch.coordinator_device_id == coordinator_device_id and
             epoch.fencing_token == fencing_token do
          {:complete, epoch}
        else
          Repo.rollback(:stale_fence)
        end
      else
        assert_room_key_coordinator!(
          epoch,
          coordinator_user_id,
          coordinator_device_id,
          fencing_token,
          now
        )

        if epoch.state not in [:preparing, :repair] do
          Repo.rollback(:epoch_not_open)
        end

        topology = lock_room_topology!(epoch.topology_id)

        valid_topology_state =
          case target_state do
            :active -> topology.state == :active
            :staged -> topology.state in [:cohorts_ready, :room_key_ready]
          end

        if not valid_topology_state or topology.generation != epoch.topology_generation do
          mark_room_key_repair!(epoch, "topology_changed")
          {:repair, :topology_changed}
        else
          cohorts = active_room_key_cohorts(topology.id)
          expected_ids = MapSet.new(cohorts, & &1.cohort.id)
          envelope_ids = MapSet.new(epoch.envelopes, & &1.cohort_id)

          complete =
            length(cohorts) == epoch.expected_cohort_count and expected_ids == envelope_ids and
              Enum.all?(cohorts, fn %{cohort: cohort, wrapping_key: wrapping_key} ->
                Enum.any?(epoch.envelopes, fn envelope ->
                  envelope.cohort_id == cohort.id and envelope.group_id == cohort.group_id and
                    not is_nil(wrapping_key) and
                    envelope.wrapping_mls_epoch == wrapping_key.mls_epoch
                end)
              end)

          if complete do
            if target_state == :active do
              from(item in RoomKeyEpoch,
                where: item.room_id == ^epoch.room_id and item.state == :active
              )
              |> Repo.update_all(
                set: [
                  state: :retired,
                  retained_until: DateTime.add(now, @room_key_retention_seconds, :second),
                  updated_at: now
                ]
              )
            end

            completed =
              epoch
              |> RoomKeyEpoch.changeset(%{
                state: target_state,
                activated_at: if(target_state == :active, do: now, else: nil),
                lease_expires_at: nil,
                repair_reason: nil
              })
              |> Repo.update!()
              |> Repo.preload(:envelopes, force: true)

            if target_state == :active do
              prune_room_key_epochs_in_transaction(epoch.room_id, now)
            end

            {:complete, completed}
          else
            mark_room_key_repair!(epoch, "incomplete_or_stale_envelopes")
            {:repair, :incomplete_envelopes}
          end
        end
      end
    end)
    |> case do
      {:ok, {:complete, epoch}} -> {:ok, epoch}
      {:ok, {:repair, reason}} -> {:error, reason}
      {:error, reason} -> {:error, reason}
    end
  end

  def report_room_key_epoch_repair(epoch_id, reason) when is_binary(reason) do
    repair_reason = String.slice(reason, 0, 255)

    Repo.transaction(fn ->
      epoch = lock_room_key_epoch!(epoch_id)
      _room = lock_room!(epoch.room_id)

      case epoch.state do
        :active ->
          active =
            epoch
            |> RoomKeyEpoch.changeset(%{repair_reason: repair_reason})
            |> Repo.update!()

          case Repo.one(
                 from(item in RoomKeyEpoch,
                   where:
                     item.room_id == ^epoch.room_id and item.id != ^epoch.id and
                       item.state in [:preparing, :repair],
                   lock: "FOR UPDATE"
                 )
               ) do
            nil -> active
            open_epoch -> mark_room_key_repair!(open_epoch, repair_reason)
          end

        state when state in [:preparing, :repair] ->
          mark_room_key_repair!(epoch, repair_reason)

        :retired ->
          Repo.rollback(:epoch_retired)
      end
    end)
    |> unwrap_transaction_result()
  end

  def get_active_room_key_epoch(room_id) do
    case get_effective_room_topology(room_id) do
      %RoomTopology{state: :cutover_appended, id: topology_id} ->
        Repo.one(
          from(epoch in RoomKeyEpoch,
            where:
              epoch.room_id == ^room_id and epoch.topology_id == ^topology_id and
                epoch.state == :staged,
            preload: [envelopes: ^from(envelope in RoomKeyEnvelope, order_by: envelope.cohort_id)]
          )
        )

      %RoomTopology{id: topology_id} ->
        Repo.one(
          from(epoch in RoomKeyEpoch,
            where:
              epoch.room_id == ^room_id and epoch.topology_id == ^topology_id and
                epoch.state == :active,
            preload: [envelopes: ^from(envelope in RoomKeyEnvelope, order_by: envelope.cohort_id)]
          )
        )

      nil ->
        nil
    end
  end

  def get_room_key_epoch(epoch_id) do
    case Repo.get(RoomKeyEpoch, epoch_id) do
      nil -> nil
      epoch -> Repo.preload(epoch, [:room, :envelopes])
    end
  end

  def get_room_key_coordination_material(room_id, topology_id \\ nil) do
    topology =
      case topology_id do
        nil -> get_effective_room_topology(room_id)
        id -> Repo.get(RoomTopology, id)
      end

    case topology do
      %RoomTopology{room_id: ^room_id, mode: :multi_cohort, state: state} = topology
      when state in [:cohorts_ready, :room_key_ready, :cutover_appended, :active] ->
        {:ok, topology, active_room_key_cohorts(topology.id)}

      _ ->
        {:error, :multi_cohort_topology_required}
    end
  end

  def prune_room_key_epochs(room_id) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    Repo.transaction(fn ->
      prune_room_key_epochs_in_transaction(room_id, now)
    end)
  end

  def purge_expired_recovery_material(now \\ DateTime.utc_now()) do
    cutoff = DateTime.truncate(now, :second)

    Repo.transaction(fn ->
      {package_count, _} =
        Repo.delete_all(
          from(package in ScopeRecoveryPackage, where: package.expires_at < ^cutoff)
        )

      {epoch_count, _} =
        Repo.delete_all(
          from(epoch in RoomKeyEpoch,
            where:
              epoch.state == :retired and not is_nil(epoch.retained_until) and
                epoch.retained_until < ^cutoff
          )
        )

      %{scope_recovery_packages: package_count, room_key_epochs: epoch_count}
    end)
  end

  defp active_room_key_cohorts(topology_id) do
    Repo.all(
      from(cohort in RoomCohort,
        left_join: wrapping_key in CohortWrappingKey,
        on: wrapping_key.cohort_id == cohort.id,
        where: cohort.topology_id == ^topology_id and cohort.state == :active,
        order_by: cohort.ordinal,
        select: %{cohort: cohort, wrapping_key: wrapping_key}
      )
    )
  end

  defp next_room_key_epoch(room_id) do
    Repo.one(
      from(epoch in RoomKeyEpoch,
        where: epoch.room_id == ^room_id,
        select: coalesce(max(epoch.epoch), 0) + 1
      )
    )
  end

  defp next_room_key_fence(room_id) do
    Repo.one(
      from(epoch in RoomKeyEpoch,
        where: epoch.room_id == ^room_id,
        select: coalesce(max(epoch.fencing_token), 0) + 1
      )
    )
  end

  defp lock_room_key_epoch!(epoch_id) do
    Repo.one!(from(epoch in RoomKeyEpoch, where: epoch.id == ^epoch_id, lock: "FOR UPDATE"))
  end

  defp assert_room_key_coordinator!(
         epoch,
         coordinator_user_id,
         coordinator_device_id,
         fencing_token,
         now
       ) do
    cond do
      epoch.coordinator_user_id != coordinator_user_id or
        epoch.coordinator_device_id != coordinator_device_id or
          epoch.fencing_token != fencing_token ->
        Repo.rollback(:stale_fence)

      is_nil(epoch.lease_expires_at) or DateTime.compare(epoch.lease_expires_at, now) != :gt ->
        Repo.rollback(:lease_expired)

      true ->
        :ok
    end
  end

  defp same_room_key_envelope?(existing, attrs) do
    existing.group_id == attrs.group_id and
      existing.wrapping_mls_epoch == attrs.wrapping_mls_epoch and
      existing.ephemeral_public_key == attrs.ephemeral_public_key and
      existing.nonce == attrs.nonce and existing.ciphertext == attrs.ciphertext and
      existing.aad_digest == attrs.aad_digest
  end

  defp mark_room_key_repair!(epoch, reason) do
    epoch
    |> RoomKeyEpoch.changeset(%{state: :repair, repair_reason: reason})
    |> Repo.update!()
  end

  defp prune_room_key_epochs_in_transaction(room_id, now) do
    expired_ids =
      Repo.all(
        from(epoch in RoomKeyEpoch,
          where:
            epoch.room_id == ^room_id and epoch.state == :retired and
              not is_nil(epoch.retained_until) and epoch.retained_until < ^now,
          select: epoch.id
        )
      )

    overflow_ids =
      Repo.all(
        from(epoch in RoomKeyEpoch,
          where: epoch.room_id == ^room_id and epoch.state == :retired,
          order_by: [desc: epoch.epoch],
          offset: ^@max_retired_room_key_epochs,
          select: epoch.id
        )
      )

    ids = Enum.uniq(expired_ids ++ overflow_ids)

    if ids != [] do
      Repo.delete_all(from(epoch in RoomKeyEpoch, where: epoch.id in ^ids))
    end

    length(ids)
  end

  def get_active_cohort_context(group_id) do
    Repo.one(
      from(cohort in RoomCohort,
        join: topology in RoomTopology,
        on: topology.id == cohort.topology_id,
        join: room in Room,
        on: room.id == topology.room_id,
        where:
          cohort.group_id == ^group_id and cohort.state == :active and
            topology.state in [:cohorts_ready, :room_key_ready, :cutover_appended, :active],
        select: {cohort, topology, room}
      )
    )
  end

  def get_active_user_cohort(group_id, user_id) do
    Repo.one(
      from(cohort in RoomCohort,
        join: topology in RoomTopology,
        on: topology.id == cohort.topology_id,
        join: membership in RoomCohortMembership,
        on: membership.cohort_id == cohort.id,
        join: room in Room,
        on: room.id == topology.room_id,
        where:
          cohort.group_id == ^group_id and cohort.state == :active and
            topology.state in [:cohorts_ready, :room_key_ready, :cutover_appended, :active] and
            membership.user_id == ^user_id,
        select: {cohort, topology, room}
      )
    )
  end

  def retire_room_cohort(cohort_id) do
    Repo.transaction(fn ->
      cohort =
        Repo.one!(from(item in RoomCohort, where: item.id == ^cohort_id, lock: "FOR UPDATE"))

      if Repo.exists?(
           from(membership in RoomCohortMembership, where: membership.cohort_id == ^cohort.id)
         ) do
        Repo.rollback(:cohort_not_empty)
      end

      now = DateTime.utc_now() |> DateTime.truncate(:second)

      cohort
      |> RoomCohort.changeset(%{state: :retired, retired_at: now})
      |> Repo.update!()
    end)
    |> unwrap_transaction_result()
  end

  defp topology_resolution(room, topology, user_id) do
    resolution =
      case topology.mode do
        mode when mode in [:single, :batched_single] ->
          %{
            cohort_id: nil,
            cohort_ordinal: nil,
            cohort_member_count: nil,
            group_id: canonical_room_group_id(room)
          }

        :multi_cohort ->
          membership = assign_user_to_cohort!(topology, user_id)
          cohort = Repo.get!(RoomCohort, membership.cohort_id)

          cohort_member_count =
            Repo.aggregate(
              from(membership in RoomCohortMembership,
                where: membership.cohort_id == ^cohort.id
              ),
              :count
            )

          %{
            cohort_id: cohort.id,
            cohort_ordinal: cohort.ordinal,
            cohort_member_count: cohort_member_count,
            group_id: cohort.group_id
          }
      end

    Map.merge(resolution, %{
      topology_id: topology.id,
      room_id: room.id,
      mode: topology.mode,
      generation: topology.generation,
      target_cohort_size: topology.target_cohort_size,
      state: topology.state,
      cutover_room_seq: topology.cutover_room_seq
    })
  end

  defp assign_user_to_cohort!(topology, user_id) do
    case Repo.get_by(RoomCohortMembership, topology_id: topology.id, user_id: user_id) do
      %RoomCohortMembership{} = membership ->
        membership

      nil ->
        cohort = available_cohort(topology) || create_cohort!(topology)

        %RoomCohortMembership{}
        |> RoomCohortMembership.changeset(%{
          topology_id: topology.id,
          cohort_id: cohort.id,
          user_id: user_id
        })
        |> Repo.insert!()
    end
  end

  defp available_cohort(topology) do
    Repo.one(
      from(cohort in RoomCohort,
        left_join: membership in RoomCohortMembership,
        on: membership.cohort_id == cohort.id,
        where: cohort.topology_id == ^topology.id and cohort.state == :active,
        group_by: cohort.id,
        having: count(membership.id) < ^topology.target_cohort_size,
        order_by: [asc: cohort.ordinal],
        limit: 1,
        select: cohort
      )
    )
  end

  defp create_cohort!(topology) do
    next_ordinal =
      Repo.one(
        from(cohort in RoomCohort,
          where: cohort.topology_id == ^topology.id,
          select: coalesce(max(cohort.ordinal), -1) + 1
        )
      )

    %RoomCohort{}
    |> RoomCohort.changeset(%{
      topology_id: topology.id,
      ordinal: next_ordinal,
      group_id: Ecto.UUID.generate(),
      state: :active
    })
    |> Repo.insert!()
  end

  defp insert_default_topology!(room) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    %RoomTopology{}
    |> RoomTopology.changeset(%{
      room_id: room.id,
      mode: :single,
      generation: next_topology_generation(room.id),
      target_cohort_size: @default_cohort_size,
      state: :active,
      cutover_room_seq: room.current_seq,
      activated_at: now
    })
    |> Repo.insert!()
  end

  defp topology_cutover_payload(topology, room_key_epoch, room_seq) do
    %{
      "topology_id" => topology.id,
      "topology_generation" => topology.generation,
      "mode" => Atom.to_string(topology.mode),
      "target_cohort_size" => topology.target_cohort_size,
      "room_key_epoch" => room_key_epoch.epoch,
      "cutover_room_seq" => room_seq
    }
  end

  defp enqueue_topology_cutover_dispatch(room, event, payload) do
    {scope_key, scope_topic} =
      case room.kind do
        :channel -> {"channel:#{room.channel_id}", "chat:channel:#{room.channel_id}"}
        :dm -> {"dm:#{room.conversation_id}", "dm:#{room.conversation_id}"}
      end

    Dispatch.enqueue(%{
      durable_key: "topology_cutover:#{room.id}:#{payload["topology_generation"]}",
      scope_key: scope_key,
      scope_topic: scope_topic,
      ordering_key: event.room_seq,
      event: "topology_cutover",
      payload: Map.put(payload, "room_seq", event.room_seq)
    })
  end

  defp staged_room_key_epoch!(topology) do
    Repo.one(
      from(epoch in RoomKeyEpoch,
        where: epoch.topology_id == ^topology.id and epoch.state == :staged,
        lock: "FOR UPDATE"
      )
    ) || Repo.rollback(:room_key_not_staged)
  end

  defp lock_room_topology!(topology_id) do
    Repo.one!(
      from(topology in RoomTopology, where: topology.id == ^topology_id, lock: "FOR UPDATE")
    )
  end

  defp lock_room_topology!(room_id, topology_id) do
    Repo.one(
      from(topology in RoomTopology,
        where: topology.id == ^topology_id and topology.room_id == ^room_id,
        lock: "FOR UPDATE"
      )
    ) || Repo.rollback(:topology_not_found)
  end

  defp room_key_topology_for_update(room_id, nil),
    do: effective_room_topology_for_update(room_id)

  defp room_key_topology_for_update(room_id, topology_id) do
    Repo.one(
      from(topology in RoomTopology,
        where: topology.id == ^topology_id and topology.room_id == ^room_id,
        lock: "FOR UPDATE"
      )
    )
  end

  defp effective_room_topology_for_update(room_id) do
    Repo.one(
      from(topology in RoomTopology,
        where: topology.room_id == ^room_id and topology.state in ^@effective_topology_states,
        order_by: [desc: topology.generation],
        limit: 1,
        lock: "FOR UPDATE"
      )
    )
  end

  defp lock_room!(room_id) do
    Repo.one!(from(room in Room, where: room.id == ^room_id, lock: "FOR UPDATE"))
  end

  defp next_topology_generation(room_id) do
    Repo.one(
      from(topology in RoomTopology,
        where: topology.room_id == ^room_id,
        select: coalesce(max(topology.generation), 0) + 1
      )
    )
  end

  defp canonical_room_group_id(%Room{channel_id: channel_id}) when is_binary(channel_id),
    do: channel_id

  defp canonical_room_group_id(%Room{conversation_id: conversation_id})
       when is_binary(conversation_id),
       do: conversation_id

  defp unwrap_transaction_result({:ok, value}), do: {:ok, value}
  defp unwrap_transaction_result({:error, reason}), do: {:error, reason}

  # --- Bounded trusted-device recovery packages ---

  @doc """
  Stores one opaque, bounded recovery package per user and scope. The server only
  compares monotonic metadata; ciphertext remains client-owned.
  """
  def upsert_scope_recovery_package(attrs) do
    Repo.transaction(fn ->
      existing =
        from(package in ScopeRecoveryPackage,
          where: package.owner_id == ^attrs.owner_id and package.scope_id == ^attrs.scope_id,
          lock: "FOR UPDATE"
        )
        |> Repo.one()

      case existing do
        nil ->
          %ScopeRecoveryPackage{}
          |> ScopeRecoveryPackage.changeset(attrs)
          |> Repo.insert()
          |> unwrap_recovery_package_result()

        package when package.membership_generation > attrs.membership_generation ->
          package

        package
        when package.membership_generation == attrs.membership_generation and
               package.last_event_seq > attrs.last_event_seq ->
          package

        package ->
          package
          |> ScopeRecoveryPackage.changeset(attrs)
          |> Repo.update()
          |> unwrap_recovery_package_result()
      end
    end)
    |> case do
      {:ok, package} -> {:ok, package}
      {:error, changeset} -> {:error, changeset}
    end
  end

  def get_scope_recovery_package(owner_id, scope_id) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    from(package in ScopeRecoveryPackage,
      where:
        package.owner_id == ^owner_id and package.scope_id == ^scope_id and
          package.expires_at > ^now
    )
    |> Repo.one()
  end

  defp unwrap_recovery_package_result({:ok, package}), do: package
  defp unwrap_recovery_package_result({:error, changeset}), do: Repo.rollback(changeset)

  # --- Pending Resync Requests ---

  @doc """
  Store or refresh a pending MLS resync request for a scope.
  """
  def store_pending_resync_request(attrs) do
    request_id = Map.get(attrs, :request_id) || Map.get(attrs, "request_id")

    requester_username =
      Map.get(attrs, :requester_username) || Map.get(attrs, "requester_username")

    requester_client_id =
      Map.get(attrs, :requester_client_id) || Map.get(attrs, "requester_client_id")

    last_known_epoch = Map.get(attrs, :last_known_epoch) || Map.get(attrs, "last_known_epoch")
    reason = Map.get(attrs, :reason) || Map.get(attrs, "reason")
    channel_id = Map.get(attrs, :channel_id) || Map.get(attrs, "channel_id")
    conversation_id = Map.get(attrs, :conversation_id) || Map.get(attrs, "conversation_id")

    %PendingResyncRequest{}
    |> PendingResyncRequest.changeset(attrs)
    |> Repo.insert(
      on_conflict: [
        set: [
          request_id: request_id,
          requester_username: requester_username,
          requester_client_id: requester_client_id,
          last_known_epoch: last_known_epoch,
          reason: reason,
          channel_id: channel_id,
          conversation_id: conversation_id,
          inserted_at: DateTime.utc_now() |> DateTime.truncate(:second)
        ]
      ],
      conflict_target: [:group_id, :requester_id, :requester_client_id]
    )
  end

  @doc """
  Get all pending resync requests for a specific MLS group scope.
  """
  def get_pending_resync_requests(group_id) do
    from(pr in PendingResyncRequest,
      where: pr.group_id == ^group_id,
      order_by: [asc: pr.inserted_at]
    )
    |> Repo.all()
  end

  @doc """
  Get a single pending resync request by id.
  """
  def get_pending_resync_request(id) do
    Repo.get(PendingResyncRequest, id)
  end

  @doc """
  Delete a pending resync request after it has been handled.

  The delete is compare-and-swap safe: callers must provide the `request_id`
  they fetched so an old ACK cannot delete a newer refreshed request for the
  same device.
  """
  def delete_pending_resync_request(id, request_id)
      when is_binary(request_id) and byte_size(request_id) > 0 do
    from(pr in PendingResyncRequest, where: pr.id == ^id and pr.request_id == ^request_id)
    |> Repo.delete_all()
  end

  # --- Durable MLS Events ---

  @doc """
  Store a replayable MLS control-plane event for an encrypted scope.
  """
  def store_mls_event(attrs) do
    insert_mls_event(attrs)
  end

  @doc """
  Store a replayable MLS commit event.

  When `idempotency_key` is present, repeated requests with the same
  group/sender/device/key tuple return the original durable event instead of
  inserting a duplicate row.
  """
  def store_mls_commit_event(attrs) do
    Repo.transaction(fn ->
      result =
        case normalize_mls_commit_idempotency_key(attrs) do
          nil ->
            insert_mls_event(attrs)

          {:error, reason} ->
            {:error, reason}

          idempotency_key ->
            store_idempotent_mls_commit_event(attrs, idempotency_key)
        end

      with {:ok, event} <- result,
           {:ok, _dispatch} <- enqueue_mls_dispatch(event, attrs) do
        event
      else
        {:error, reason} -> Repo.rollback(reason)
      end
    end)
    |> case do
      {:ok, event} -> {:ok, event}
      {:error, reason} -> {:error, reason}
    end
  end

  @doc """
  Store a replayable MLS remove event and atomically complete any linked crypto eviction.
  """
  def store_mls_remove_event(attrs, crypto_eviction \\ nil) do
    Repo.transaction(fn ->
      with {:ok, event} <- insert_mls_event(attrs),
           :ok <- maybe_complete_pending_crypto_eviction(crypto_eviction, event.id),
           {:ok, _dispatch} <- enqueue_mls_dispatch(event, attrs) do
        event
      else
        {:error, %Ecto.Changeset{} = changeset} ->
          Repo.rollback(changeset)

        {:error, reason} ->
          Repo.rollback(reason)
      end
    end)
    |> case do
      {:ok, event} -> {:ok, event}
      {:error, reason} -> {:error, reason}
    end
  end

  defp insert_mls_event(attrs) do
    %MlsEvent{}
    |> MlsEvent.changeset(attrs)
    |> Repo.insert()
  end

  defp enqueue_mls_dispatch(event, attrs) do
    channel_id = Map.get(attrs, :channel_id) || Map.get(attrs, "channel_id")
    conversation_id = Map.get(attrs, :conversation_id) || Map.get(attrs, "conversation_id")

    {scope_key, scope_topic} =
      cond do
        is_binary(channel_id) -> {"channel:#{channel_id}", "chat:channel:#{channel_id}"}
        is_binary(conversation_id) -> {"dm:#{conversation_id}", "dm:#{conversation_id}"}
        true -> {"group:#{event.group_id}", "group:#{event.group_id}"}
      end

    payload =
      (event.payload || %{})
      |> Map.put("seq", event.id)
      |> Map.put("sender_id", event.sender_id)
      |> Map.put("sender_device_id", event.sender_device_id)

    Dispatch.enqueue(%{
      durable_key: "mls_event:#{event.id}",
      scope_key: scope_key,
      scope_topic: scope_topic,
      ordering_key: event.id,
      event: event.event_type,
      payload: payload
    })
  end

  def get_group_info_epoch(group_id) do
    case Repo.one(from(gi in MlsGroupInfo, where: gi.group_id == ^group_id, select: gi.epoch)) do
      nil -> {:error, :not_found}
      epoch -> {:ok, epoch}
    end
  end

  defp current_group_generation(group_id) do
    case get_group_info_epoch(group_id) do
      {:ok, epoch} -> epoch
      {:error, :not_found} -> 0
    end
  end

  @doc """
  Atomically store an optional remove event, the durable commit event, and an
  optional pending welcome for a sponsored join/resync transition.
  """
  def publish_sponsored_transition(attrs) do
    group_id = Map.get(attrs, :group_id) || Map.get(attrs, "group_id")
    group_info_data = Map.get(attrs, :group_info_data) || Map.get(attrs, "group_info_data")
    new_epoch = Map.get(attrs, :epoch) || Map.get(attrs, "epoch") || 0
    previous_epoch = Map.get(attrs, :previous_epoch) || Map.get(attrs, "previous_epoch")
    commit_data = Map.get(attrs, :commit_data) || Map.get(attrs, "commit_data")
    commit_id = Map.get(attrs, :commit_id) || Map.get(attrs, "commit_id")

    remove_commit_data =
      Map.get(attrs, :remove_commit_data) || Map.get(attrs, "remove_commit_data")

    recipient_id = Map.get(attrs, :recipient_id) || Map.get(attrs, "recipient_id")

    recipient_client_id =
      Map.get(attrs, :recipient_client_id) || Map.get(attrs, "recipient_client_id")

    welcome_data = Map.get(attrs, :welcome_data) || Map.get(attrs, "welcome_data")

    key_package_ref =
      Map.get(attrs, :recipient_key_package_ref) || Map.get(attrs, "recipient_key_package_ref")

    with true <- (is_binary(group_id) and group_id != "") || {:error, :invalid_transition_scope},
         true <-
           (is_binary(group_info_data) and group_info_data != "") || {:error, :invalid_group_info},
         true <- is_integer(previous_epoch) || {:error, :invalid_previous_epoch},
         true <- (is_binary(commit_data) and commit_data != "") || {:error, :invalid_commit_data},
         true <- (is_binary(commit_id) and commit_id != "") || {:error, :invalid_idempotency_key},
         true <- (is_binary(recipient_id) and recipient_id != "") || {:error, :invalid_recipient},
         {:ok, commit_attrs} <-
           normalize_mls_commit_event_attrs(
             %{
               group_id: group_id,
               event_type: "mls_commit",
               payload: %{
                 commit_data: commit_data,
                 transition_type: "sponsored_join",
                 joined_user_id: recipient_id,
                 joined_device_id: recipient_client_id,
                 resulting_generation: new_epoch
               },
               sender_id: Map.get(attrs, :sender_id) || Map.get(attrs, "sender_id"),
               sender_device_id:
                 Map.get(attrs, :sender_device_id) || Map.get(attrs, "sender_device_id"),
               channel_id: Map.get(attrs, :channel_id) || Map.get(attrs, "channel_id"),
               conversation_id:
                 Map.get(attrs, :conversation_id) || Map.get(attrs, "conversation_id")
             },
             commit_id
           ) do
      Repo.transaction(fn ->
        lock_group_info_publish(group_id)

        existing =
          from(gi in MlsGroupInfo,
            where: gi.group_id == ^group_id,
            lock: "FOR UPDATE"
          )
          |> Repo.one()

        case existing_sponsored_transition_success(
               existing,
               attrs,
               new_epoch,
               commit_attrs,
               recipient_id,
               recipient_client_id
             ) do
          {:ok, result} ->
            result

          :error ->
            Repo.rollback(:idempotency_conflict)

          nil ->
            with {:ok, _group_info} <-
                   apply_group_info_publish(existing, attrs, new_epoch, previous_epoch),
                 {:ok, remove_event} <-
                   maybe_insert_sponsored_remove_event(
                     attrs,
                     remove_commit_data,
                     recipient_id,
                     recipient_client_id,
                     new_epoch
                   ),
                 {:ok, commit_event} <- insert_idempotent_mls_commit_event(commit_attrs),
                 {:ok, welcome} <-
                   maybe_upsert_sponsored_welcome(attrs, welcome_data, key_package_ref) do
              %{
                fresh: true,
                remove_event: remove_event,
                commit_event: commit_event,
                welcome: welcome
              }
            else
              {:error, %Ecto.Changeset{} = changeset} ->
                Repo.rollback(changeset)

              {:error, reason} ->
                Repo.rollback(reason)
            end
        end
      end)
      |> case do
        {:ok, transition} -> {:ok, transition}
        {:error, :epoch_conflict} -> {:error, :epoch_conflict}
        {:error, reason} -> {:error, reason}
      end
    else
      {:error, reason} -> {:error, reason}
      false -> {:error, :invalid_sponsored_transition}
    end
  end

  defp store_idempotent_mls_commit_event(attrs, idempotency_key) do
    with {:ok, normalized_attrs} <- normalize_mls_commit_event_attrs(attrs, idempotency_key),
         {:ok, event} <- insert_idempotent_mls_commit_event(normalized_attrs) do
      {:ok, event}
    end
  end

  defp normalize_mls_commit_event_attrs(attrs, idempotency_key) do
    group_id = Map.get(attrs, :group_id) || Map.get(attrs, "group_id")
    sender_id = Map.get(attrs, :sender_id) || Map.get(attrs, "sender_id")
    sender_device_id = Map.get(attrs, :sender_device_id) || Map.get(attrs, "sender_device_id")
    payload = Map.get(attrs, :payload) || Map.get(attrs, "payload")

    cond do
      not (is_binary(group_id) and group_id != "") ->
        {:error, :invalid_commit_scope}

      not (is_binary(sender_id) and sender_id != "") ->
        {:error, :invalid_commit_scope}

      not (is_binary(sender_device_id) and sender_device_id != "") ->
        {:error, :invalid_commit_scope}

      not is_map(payload) ->
        {:error, :invalid_commit_scope}

      true ->
        {:ok,
         attrs
         |> Map.put(:idempotency_key, idempotency_key)
         |> Map.put(:payload, stringify_map_keys(payload))}
    end
  end

  defp insert_idempotent_mls_commit_event(attrs) do
    expected_payload = Map.fetch!(attrs, :payload)

    unique_target =
      {:unsafe_fragment,
       "(group_id, event_type, sender_id, sender_device_id, idempotency_key) WHERE event_type = 'mls_commit' AND idempotency_key IS NOT NULL"}

    case Repo.insert(%MlsEvent{} |> MlsEvent.changeset(attrs),
           on_conflict: :nothing,
           conflict_target: unique_target,
           returning: true
         ) do
      {:ok, %MlsEvent{id: nil}} ->
        case fetch_mls_commit_event_by_idempotency_key(attrs) do
          nil -> {:error, :idempotency_conflict}
          %MlsEvent{payload: payload} = event when payload == expected_payload -> {:ok, event}
          %MlsEvent{} -> {:error, :idempotency_conflict}
        end

      {:ok, event} ->
        {:ok, event}

      {:error, %Ecto.Changeset{} = changeset} ->
        {:error, changeset}
    end
  end

  defp fetch_mls_commit_event_by_idempotency_key(attrs) do
    group_id = Map.fetch!(attrs, :group_id)
    sender_id = Map.fetch!(attrs, :sender_id)
    sender_device_id = Map.fetch!(attrs, :sender_device_id)
    idempotency_key = Map.fetch!(attrs, :idempotency_key)

    from(event in MlsEvent,
      where:
        event.group_id == ^group_id and
          event.event_type == "mls_commit" and
          event.sender_id == ^sender_id and
          event.sender_device_id == ^sender_device_id and
          event.idempotency_key == ^idempotency_key
    )
    |> Repo.one()
  end

  defp normalize_mls_commit_idempotency_key(attrs) do
    case Map.get(attrs, :idempotency_key) || Map.get(attrs, "idempotency_key") do
      value when is_binary(value) and value != "" -> value
      nil -> nil
      _ -> {:error, :invalid_idempotency_key}
    end
  end

  defp upsert_pending_welcome(attrs) do
    recipient_id = Map.get(attrs, :recipient_id) || Map.get(attrs, "recipient_id")
    group_id = Map.get(attrs, :group_id) || Map.get(attrs, "group_id")

    recipient_client_id =
      Map.get(attrs, :recipient_client_id) || Map.get(attrs, "recipient_client_id")

    has_client_id = is_binary(recipient_client_id) and byte_size(recipient_client_id) > 0

    if recipient_id && group_id && has_client_id do
      from(pw in PendingWelcome,
        where:
          pw.recipient_id == ^recipient_id and pw.group_id == ^group_id and
            is_nil(pw.recipient_client_id)
      )
      |> Repo.delete_all()
    end

    changeset = PendingWelcome.changeset(%PendingWelcome{}, attrs)

    conflict_target =
      if has_client_id do
        {:unsafe_fragment,
         "(recipient_id, group_id, recipient_client_id) WHERE recipient_client_id IS NOT NULL"}
      else
        {:unsafe_fragment, "(recipient_id, group_id) WHERE recipient_client_id IS NULL"}
      end

    Repo.insert(changeset,
      on_conflict:
        {:replace,
         [
           :welcome_data,
           :sender_id,
           :recipient_key_package_ref,
           :channel_id,
           :conversation_id
         ]},
      conflict_target: conflict_target,
      returning: true
    )
  end

  defp fetch_pending_welcome_for_scope(recipient_id, group_id, recipient_client_id) do
    query =
      from(pw in PendingWelcome,
        where: pw.recipient_id == ^recipient_id and pw.group_id == ^group_id
      )

    query =
      if is_binary(recipient_client_id) and byte_size(recipient_client_id) > 0 do
        from(pw in query, where: pw.recipient_client_id == ^recipient_client_id)
      else
        from(pw in query, where: is_nil(pw.recipient_client_id))
      end

    Repo.one(query)
  end

  defp maybe_insert_sponsored_remove_event(
         _attrs,
         nil,
         _recipient_id,
         _recipient_client_id,
         _resulting_generation
       ),
       do: {:ok, nil}

  defp maybe_insert_sponsored_remove_event(
         attrs,
         remove_commit_data,
         recipient_id,
         recipient_client_id,
         resulting_generation
       )
       when is_binary(remove_commit_data) and remove_commit_data != "" do
    insert_mls_event(%{
      group_id: Map.get(attrs, :group_id) || Map.get(attrs, "group_id"),
      channel_id: Map.get(attrs, :channel_id) || Map.get(attrs, "channel_id"),
      conversation_id: Map.get(attrs, :conversation_id) || Map.get(attrs, "conversation_id"),
      event_type: "mls_remove",
      payload:
        %{
          removed_user_id: recipient_id,
          commit_data: remove_commit_data,
          resulting_generation: resulting_generation
        }
        |> maybe_put_remove_device(recipient_client_id)
        |> stringify_map_keys(),
      sender_id: Map.get(attrs, :sender_id) || Map.get(attrs, "sender_id"),
      sender_device_id: Map.get(attrs, :sender_device_id) || Map.get(attrs, "sender_device_id")
    })
  end

  defp maybe_insert_sponsored_remove_event(
         _attrs,
         _remove_commit_data,
         _recipient_id,
         _recipient_client_id,
         _resulting_generation
       ),
       do: {:error, :invalid_remove_commit_data}

  defp maybe_upsert_sponsored_welcome(_attrs, nil, _key_package_ref), do: {:ok, nil}

  defp maybe_upsert_sponsored_welcome(attrs, welcome_data, key_package_ref)
       when is_binary(welcome_data) and byte_size(welcome_data) > 0 do
    upsert_pending_welcome(
      attrs
      |> Map.put(:welcome_data, welcome_data)
      |> Map.put(:recipient_key_package_ref, key_package_ref)
    )
  end

  defp maybe_upsert_sponsored_welcome(_attrs, _welcome_data, _key_package_ref),
    do: {:error, :invalid_welcome_data}

  defp maybe_put_remove_device(payload, recipient_client_id)
       when is_binary(recipient_client_id) and byte_size(recipient_client_id) > 0 do
    Map.put(payload, :removed_device_id, recipient_client_id)
  end

  defp maybe_put_remove_device(payload, _recipient_client_id), do: payload

  defp stringify_map_keys(map) when is_map(map) do
    Enum.reduce(map, %{}, fn {key, value}, acc ->
      Map.put(acc, to_string(key), value)
    end)
  end

  defp stringify_map_keys(value), do: value

  @doc """
  List replayable MLS control-plane events for a scope after the given local cursor.
  """
  def list_mls_events_after(group_id, after_seq \\ 0, limit \\ 200) do
    from(event in MlsEvent,
      where: event.group_id == ^group_id and event.id > ^after_seq,
      order_by: [asc: event.id],
      limit: ^limit
    )
    |> Repo.all()
  end

  @doc """
  List the most recent replayable MLS control-plane events for a scope.
  """
  def list_recent_mls_events(group_id, limit \\ 50, event_type \\ nil) do
    query =
      from(event in MlsEvent,
        where: event.group_id == ^group_id,
        order_by: [desc: event.id],
        limit: ^limit
      )

    query =
      if is_binary(event_type) and byte_size(event_type) > 0 do
        from(event in query, where: event.event_type == ^event_type)
      else
        query
      end

    Repo.all(query)
  end

  # --- Pending Crypto Evictions ---

  def queue_scope_crypto_evictions(evictions) when is_list(evictions) do
    if evictions == [] do
      :ok
    else
      now = DateTime.utc_now() |> DateTime.truncate(:second)

      entries =
        Enum.map(evictions, fn eviction ->
          %{
            id: Ecto.UUID.generate(),
            scope_kind: eviction.scope_kind,
            scope_id: eviction.scope_id,
            group_id: eviction.group_id,
            server_id: eviction.server_id,
            target_user_id: eviction.target_user_id,
            target_device_id: eviction.target_device_id,
            reason: eviction.reason,
            status: "pending",
            attempt_count: 0,
            membership_generation: current_group_generation(eviction.group_id),
            fencing_token: 0,
            inserted_at: now,
            updated_at: now
          }
        end)

      Repo.insert_all(PendingCryptoEviction, entries)

      evictions
      |> Enum.map(&{&1.scope_kind, &1.scope_id})
      |> Enum.uniq()
      |> Enum.each(fn {scope_kind, scope_id} ->
        :ok = enqueue_crypto_eviction_scope(scope_kind, scope_id)
      end)

      :ok
    end
  end

  def cancel_rejoined_server_member_evictions(server_id, user_id) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    from(eviction in PendingCryptoEviction,
      where:
        eviction.server_id == ^server_id and
          eviction.target_user_id == ^user_id and
          eviction.status in ["pending", "requested", "claimed"]
    )
    |> Repo.update_all(
      set: [
        status: "cancelled",
        last_error: "target_rejoined",
        applied_at: now,
        lease_expires_at: nil,
        updated_at: now
      ]
    )

    :ok
  end

  def enqueue_crypto_eviction_scope(scope_kind, scope_id, opts \\ []) do
    schedule_in = Keyword.get(opts, :schedule_in, 0)

    %{"scope_kind" => scope_kind, "scope_id" => scope_id}
    |> Vesper.Workers.ProcessPendingCryptoEvictions.new(schedule_in: schedule_in)
    |> Oban.insert()
    |> case do
      {:ok, _job} ->
        :ok

      {:error, %Ecto.Changeset{} = changeset} ->
        if unique_constraint_error?(changeset) do
          :ok
        else
          {:error, changeset}
        end

      {:error, changeset} ->
        {:error, changeset}
    end
  end

  defp unique_constraint_error?(%Ecto.Changeset{} = changeset) do
    Enum.any?(changeset.errors, fn
      {_field, {_message, meta}} ->
        meta[:constraint] == :unique or meta[:error_type] == :unique

      _ ->
        false
    end)
  end

  def request_next_pending_crypto_eviction(scope_kind, scope_id) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)
    requested_cutoff = DateTime.add(now, -5, :second)

    Repo.transaction(fn ->
      query =
        from(eviction in PendingCryptoEviction,
          where:
            eviction.scope_kind == ^scope_kind and
              eviction.scope_id == ^scope_id and
              (eviction.status == "pending" or
                 (eviction.status == "requested" and
                    (is_nil(eviction.requested_at) or eviction.requested_at < ^requested_cutoff)) or
                 (eviction.status == "claimed" and
                    (is_nil(eviction.lease_expires_at) or eviction.lease_expires_at < ^now))),
          order_by: [asc: eviction.inserted_at],
          limit: 1,
          lock: "FOR UPDATE SKIP LOCKED"
        )

      case Repo.one(query) do
        nil ->
          nil

        eviction ->
          {:ok, requested} =
            eviction
            |> PendingCryptoEviction.changeset(%{
              status: "requested",
              attempt_count: eviction.attempt_count + 1,
              membership_generation: current_group_generation(eviction.group_id),
              fencing_token: eviction.fencing_token + 1,
              lease_expires_at: nil,
              last_error: nil,
              sponsor_user_id: nil,
              sponsor_device_id: nil,
              requested_at: now,
              claimed_at: nil
            })
            |> Repo.update()

          requested
      end
    end)
    |> case do
      {:ok, eviction} -> eviction
      {:error, _reason} -> nil
    end
  end

  def request_pending_crypto_eviction_batch(scope_kind, scope_id, limit \\ 8)
      when is_integer(limit) and limit > 0 do
    Enum.reduce_while(1..limit, [], fn _, acc ->
      case request_next_pending_crypto_eviction(scope_kind, scope_id) do
        nil -> {:halt, Enum.reverse(acc)}
        eviction -> {:cont, [eviction | acc]}
      end
    end)
  end

  def has_active_crypto_evictions?(scope_kind, scope_id) do
    from(eviction in PendingCryptoEviction,
      where:
        eviction.scope_kind == ^scope_kind and
          eviction.scope_id == ^scope_id and
          eviction.status in ["pending", "requested", "claimed"]
    )
    |> Repo.exists?()
  end

  def claim_pending_crypto_eviction(
        id,
        scope_kind,
        scope_id,
        sponsor_user_id,
        sponsor_device_id,
        fencing_token,
        membership_generation
      ) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)
    lease_expires_at = DateTime.add(now, @sponsor_lease_seconds, :second)

    Repo.transaction(fn ->
      case lock_crypto_eviction(id, scope_kind, scope_id) do
        nil ->
          Repo.rollback(:not_found)

        %PendingCryptoEviction{target_user_id: target_user_id}
        when target_user_id == sponsor_user_id ->
          Repo.rollback(:target_cannot_sponsor)

        %PendingCryptoEviction{} = eviction ->
          cond do
            server_membership_active?(eviction.server_id, eviction.target_user_id) ->
              {:ok, cancelled} =
                eviction
                |> PendingCryptoEviction.changeset(%{
                  status: "cancelled",
                  last_error: "target_rejoined",
                  applied_at: now,
                  lease_expires_at: nil
                })
                |> Repo.update()

              {:cancelled, cancelled}

            eviction.fencing_token != fencing_token ->
              Repo.rollback(:stale_fence)

            eviction.membership_generation != membership_generation ->
              Repo.rollback(:stale_generation)

            current_group_generation(eviction.group_id) != membership_generation ->
              Repo.rollback(:stale_generation)

            eviction.status == "claimed" and
              eviction.sponsor_user_id == sponsor_user_id and
                eviction.sponsor_device_id == sponsor_device_id ->
              eviction

            eviction.status != "requested" ->
              Repo.rollback(:not_claimable)

            true ->
              {:ok, claimed} =
                eviction
                |> PendingCryptoEviction.changeset(%{
                  status: "claimed",
                  sponsor_user_id: sponsor_user_id,
                  sponsor_device_id: sponsor_device_id,
                  claimed_at: now,
                  lease_expires_at: lease_expires_at
                })
                |> Repo.update()

              claimed
          end
      end
    end)
    |> case do
      {:ok, {:cancelled, _eviction}} -> {:error, :target_rejoined}
      {:ok, eviction} -> {:ok, eviction}
      {:error, reason} -> {:error, reason}
    end
  end

  def renew_pending_crypto_eviction(
        id,
        scope_kind,
        scope_id,
        sponsor_user_id,
        sponsor_device_id,
        fencing_token
      ) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    Repo.transaction(fn ->
      case lock_crypto_eviction(id, scope_kind, scope_id) do
        %PendingCryptoEviction{
          status: "claimed",
          sponsor_user_id: ^sponsor_user_id,
          sponsor_device_id: ^sponsor_device_id,
          fencing_token: ^fencing_token
        } = eviction ->
          if eviction.lease_expires_at && DateTime.compare(eviction.lease_expires_at, now) == :lt do
            Repo.rollback(:lease_expired)
          end

          eviction
          |> PendingCryptoEviction.changeset(%{
            lease_expires_at: DateTime.add(now, @sponsor_lease_seconds, :second)
          })
          |> Repo.update!()

        %PendingCryptoEviction{} ->
          Repo.rollback(:stale_fence)

        nil ->
          Repo.rollback(:not_found)
      end
    end)
  end

  def abandon_pending_crypto_eviction(
        id,
        scope_kind,
        scope_id,
        sponsor_user_id,
        sponsor_device_id,
        fencing_token,
        reason
      ) do
    Repo.transaction(fn ->
      case lock_crypto_eviction(id, scope_kind, scope_id) do
        %PendingCryptoEviction{
          status: "claimed",
          sponsor_user_id: ^sponsor_user_id,
          sponsor_device_id: ^sponsor_device_id,
          fencing_token: ^fencing_token
        } = eviction ->
          eviction
          |> PendingCryptoEviction.changeset(%{
            status: "requested",
            sponsor_user_id: nil,
            sponsor_device_id: nil,
            claimed_at: nil,
            lease_expires_at: nil,
            last_error: reason
          })
          |> Repo.update!()

        %PendingCryptoEviction{} ->
          Repo.rollback(:stale_fence)

        nil ->
          Repo.rollback(:not_found)
      end
    end)
  end

  def complete_pending_crypto_eviction(
        id,
        scope_kind,
        scope_id,
        removed_user_id,
        removed_device_id,
        commit_event_id,
        sponsor_user_id,
        sponsor_device_id,
        fencing_token,
        membership_generation
      ) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    Repo.transaction(fn ->
      case complete_pending_crypto_eviction_transaction(
             id,
             scope_kind,
             scope_id,
             removed_user_id,
             removed_device_id,
             commit_event_id,
             sponsor_user_id,
             sponsor_device_id,
             fencing_token,
             membership_generation,
             now
           ) do
        {:ok, eviction} -> eviction
        {:error, reason} -> Repo.rollback(reason)
      end
    end)
    |> case do
      {:ok, eviction} -> {:ok, eviction}
      {:error, reason} -> {:error, reason}
    end
  end

  defp maybe_complete_pending_crypto_eviction(evictions, commit_event_id)
       when is_list(evictions) do
    Enum.reduce_while(evictions, :ok, fn eviction, :ok ->
      case maybe_complete_pending_crypto_eviction(eviction, commit_event_id) do
        :ok -> {:cont, :ok}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  defp maybe_complete_pending_crypto_eviction(nil, _commit_event_id), do: :ok

  defp maybe_complete_pending_crypto_eviction(crypto_eviction, commit_event_id) do
    case complete_pending_crypto_eviction_transaction(
           crypto_eviction.eviction_id,
           crypto_eviction.scope_kind,
           crypto_eviction.scope_id,
           crypto_eviction.removed_user_id,
           crypto_eviction.removed_device_id,
           commit_event_id,
           crypto_eviction.sponsor_user_id,
           crypto_eviction.sponsor_device_id,
           crypto_eviction.fencing_token,
           crypto_eviction.membership_generation,
           DateTime.utc_now() |> DateTime.truncate(:second)
         ) do
      {:ok, _eviction} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

  defp complete_pending_crypto_eviction_transaction(
         id,
         scope_kind,
         scope_id,
         removed_user_id,
         removed_device_id,
         commit_event_id,
         sponsor_user_id,
         sponsor_device_id,
         fencing_token,
         membership_generation,
         now
       ) do
    case lock_crypto_eviction(id, scope_kind, scope_id) do
      nil ->
        {:error, :not_found}

      %PendingCryptoEviction{} = eviction ->
        cond do
          eviction.target_user_id != removed_user_id ->
            {:error, :target_mismatch}

          not is_nil(eviction.target_device_id) and
              eviction.target_device_id != removed_device_id ->
            {:error, :target_device_mismatch}

          eviction.status != "claimed" ->
            {:error, :not_claimable}

          eviction.fencing_token != fencing_token ->
            {:error, :stale_fence}

          eviction.membership_generation != membership_generation ->
            {:error, :stale_generation}

          current_group_generation(eviction.group_id) != membership_generation ->
            {:error, :stale_generation}

          eviction.lease_expires_at && DateTime.compare(eviction.lease_expires_at, now) == :lt ->
            {:error, :lease_expired}

          eviction.sponsor_user_id != sponsor_user_id or
              eviction.sponsor_device_id != sponsor_device_id ->
            {:error, :sponsor_mismatch}

          true ->
            {:ok, committed} =
              eviction
              |> PendingCryptoEviction.changeset(%{
                status: "committed",
                sponsor_user_id: sponsor_user_id,
                sponsor_device_id: sponsor_device_id,
                commit_event_id: commit_event_id,
                committed_at: now,
                applied_at: nil,
                lease_expires_at: nil,
                result: %{
                  "commit_event_id" => commit_event_id,
                  "fencing_token" => fencing_token,
                  "membership_generation" => membership_generation
                },
                last_error: nil
              })
              |> Repo.update()

            purge_pending_crypto_artifacts(
              committed.group_id,
              committed.target_user_id,
              committed.target_device_id
            )

            {:ok, committed}
        end
    end
  end

  def skip_pending_crypto_eviction(
        id,
        scope_kind,
        scope_id,
        target_user_id,
        target_device_id,
        sponsor_user_id,
        sponsor_device_id,
        fencing_token,
        membership_generation,
        reason
      ) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    Repo.transaction(fn ->
      case lock_crypto_eviction(id, scope_kind, scope_id) do
        nil ->
          Repo.rollback(:not_found)

        %PendingCryptoEviction{} = eviction ->
          cond do
            eviction.target_user_id != target_user_id ->
              Repo.rollback(:target_mismatch)

            not is_nil(eviction.target_device_id) and
                eviction.target_device_id != target_device_id ->
              Repo.rollback(:target_device_mismatch)

            eviction.status != "claimed" ->
              Repo.rollback(:not_claimable)

            eviction.fencing_token != fencing_token ->
              Repo.rollback(:stale_fence)

            eviction.membership_generation != membership_generation ->
              Repo.rollback(:stale_generation)

            eviction.sponsor_user_id != sponsor_user_id or
                eviction.sponsor_device_id != sponsor_device_id ->
              Repo.rollback(:sponsor_mismatch)

            true ->
              {:ok, applied} =
                eviction
                |> PendingCryptoEviction.changeset(%{
                  status: "applied",
                  sponsor_user_id: sponsor_user_id,
                  sponsor_device_id: sponsor_device_id,
                  applied_at: now,
                  lease_expires_at: nil,
                  result: %{
                    "status" => "skipped",
                    "reason" => reason,
                    "fencing_token" => fencing_token,
                    "membership_generation" => membership_generation
                  },
                  last_error: reason
                })
                |> Repo.update()

              purge_pending_crypto_artifacts(
                applied.group_id,
                applied.target_user_id,
                applied.target_device_id
              )

              applied
          end
      end
    end)
    |> case do
      {:ok, eviction} -> {:ok, eviction}
      {:error, reason} -> {:error, reason}
    end
  end

  def list_pending_crypto_evictions(scope_kind, scope_id) do
    from(eviction in PendingCryptoEviction,
      where: eviction.scope_kind == ^scope_kind and eviction.scope_id == ^scope_id,
      order_by: [asc: eviction.inserted_at]
    )
    |> Repo.all()
  end

  defp server_membership_active?(server_id, user_id) do
    from(membership in Membership,
      where: membership.server_id == ^server_id and membership.user_id == ^user_id
    )
    |> Repo.exists?()
  end

  defp lock_crypto_eviction(id, scope_kind, scope_id) do
    from(eviction in PendingCryptoEviction,
      where:
        eviction.id == ^id and
          eviction.scope_kind == ^scope_kind and
          eviction.scope_id == ^scope_id,
      limit: 1,
      lock: "FOR UPDATE"
    )
    |> Repo.one()
  end

  defp purge_pending_crypto_artifacts(group_id, target_user_id, target_device_id) do
    delete_pending_welcomes(group_id, target_user_id, target_device_id)
    delete_pending_history_bundles(group_id, target_user_id, target_device_id)

    history_query =
      from(request in PendingHistoryRequest,
        where: request.group_id == ^group_id and request.requester_id == ^target_user_id
      )

    history_query =
      if is_binary(target_device_id) and byte_size(target_device_id) > 0 do
        from(request in history_query, where: request.requester_client_id == ^target_device_id)
      else
        history_query
      end

    Repo.delete_all(history_query)

    resync_query =
      from(request in PendingResyncRequest,
        where: request.group_id == ^group_id and request.requester_id == ^target_user_id
      )

    resync_query =
      if is_binary(target_device_id) and byte_size(target_device_id) > 0 do
        from(request in resync_query, where: request.requester_client_id == ^target_device_id)
      else
        resync_query
      end

    Repo.delete_all(resync_query)

    :ok
  end

  defp delete_pending_welcomes(group_id, target_user_id, target_device_id) do
    query =
      from(welcome in PendingWelcome,
        where: welcome.group_id == ^group_id and welcome.recipient_id == ^target_user_id
      )

    query =
      if is_binary(target_device_id) and byte_size(target_device_id) > 0 do
        from(welcome in query,
          where:
            welcome.recipient_client_id == ^target_device_id or
              is_nil(welcome.recipient_client_id)
        )
      else
        query
      end

    Repo.delete_all(query)
  end

  defp delete_pending_history_bundles(group_id, target_user_id, target_device_id) do
    query =
      from(bundle in PendingHistoryBundle,
        where: bundle.group_id == ^group_id and bundle.recipient_id == ^target_user_id
      )

    query =
      if is_binary(target_device_id) and byte_size(target_device_id) > 0 do
        from(bundle in query, where: bundle.recipient_client_id == ^target_device_id)
      else
        query
      end

    Repo.delete_all(query)
  end

  # --- MLS GroupInfo (for External Commits) ---

  @doc """
  Publish (upsert) MLS GroupInfo for a scope.
  Only stores the latest — each publish replaces the previous.

  When `previous_epoch` is provided, uses compare-and-swap (CAS) semantics:
  the update only succeeds if the stored epoch matches `previous_epoch`.
  Returns `{:error, :epoch_conflict}` on mismatch. This serializes
  concurrent External Commit joins — only one joiner can claim a given
  epoch transition.

  Without `previous_epoch`, uses the original `>=` semantics for backward
  compatibility (regular post-commit GroupInfo publishes).
  """
  def publish_group_info(attrs) do
    group_id = Map.get(attrs, :group_id) || Map.get(attrs, "group_id")
    new_epoch = Map.get(attrs, :epoch) || Map.get(attrs, "epoch") || 0
    previous_epoch = Map.get(attrs, :previous_epoch) || Map.get(attrs, "previous_epoch")

    Repo.transaction(fn ->
      lock_group_info_publish(group_id)

      existing =
        from(gi in MlsGroupInfo,
          where: gi.group_id == ^group_id,
          lock: "FOR UPDATE"
        )
        |> Repo.one()

      case apply_group_info_publish(existing, attrs, new_epoch, previous_epoch) do
        {:ok, group_info} -> group_info
        {:error, reason} -> Repo.rollback(reason)
      end
    end)
    |> case do
      {:ok, group_info} -> {:ok, group_info}
      {:error, :epoch_conflict} -> {:error, :epoch_conflict}
      {:error, reason} -> {:error, reason}
    end
  end

  @doc """
  Atomically publish External Commit GroupInfo and store the matching durable
  `mls_commit` event. Retries with the same commit id return the existing
  success instead of conflicting.
  """
  def publish_external_commit_group_info(attrs) do
    group_id = Map.get(attrs, :group_id) || Map.get(attrs, "group_id")
    new_epoch = Map.get(attrs, :epoch) || Map.get(attrs, "epoch") || 0
    previous_epoch = Map.get(attrs, :previous_epoch) || Map.get(attrs, "previous_epoch")
    commit_data = Map.get(attrs, :commit_data) || Map.get(attrs, "commit_data")
    commit_id = Map.get(attrs, :commit_id) || Map.get(attrs, "commit_id")

    with true <- is_integer(previous_epoch) || {:error, :invalid_previous_epoch},
         true <- (is_binary(commit_data) and commit_data != "") || {:error, :invalid_commit_data},
         true <- (is_binary(commit_id) and commit_id != "") || {:error, :invalid_idempotency_key},
         {:ok, commit_attrs} <-
           normalize_mls_commit_event_attrs(
             %{
               group_id: group_id,
               event_type: "mls_commit",
               payload: %{
                 commit_data: commit_data,
                 transition_type: "external_commit",
                 joined_user_id: Map.get(attrs, :publisher_id) || Map.get(attrs, "publisher_id"),
                 joined_device_id:
                   Map.get(attrs, :publisher_client_id) || Map.get(attrs, "publisher_client_id"),
                 resulting_generation: new_epoch
               },
               sender_id: Map.get(attrs, :publisher_id) || Map.get(attrs, "publisher_id"),
               sender_device_id:
                 Map.get(attrs, :publisher_client_id) || Map.get(attrs, "publisher_client_id"),
               channel_id: Map.get(attrs, :channel_id) || Map.get(attrs, "channel_id"),
               conversation_id:
                 Map.get(attrs, :conversation_id) || Map.get(attrs, "conversation_id")
             },
             commit_id
           ) do
      Repo.transaction(fn ->
        lock_group_info_publish(group_id)

        existing =
          from(gi in MlsGroupInfo,
            where: gi.group_id == ^group_id,
            lock: "FOR UPDATE"
          )
          |> Repo.one()

        case existing_external_commit_success(existing, attrs, new_epoch, commit_attrs) do
          {:ok, result} ->
            result

          :error ->
            Repo.rollback(:idempotency_conflict)

          nil ->
            with {:ok, group_info} <-
                   apply_group_info_publish(existing, attrs, new_epoch, previous_epoch),
                 {:ok, event} <- insert_idempotent_mls_commit_event(commit_attrs) do
              %{group_info: group_info, event: event}
            else
              {:error, reason} -> Repo.rollback(reason)
            end
        end
      end)
      |> case do
        {:ok, result} -> {:ok, result}
        {:error, :epoch_conflict} -> {:error, :epoch_conflict}
        {:error, reason} -> {:error, reason}
      end
    else
      {:error, reason} -> {:error, reason}
      false -> {:error, :invalid_external_commit}
    end
  end

  defp apply_group_info_publish(nil, attrs, _new_epoch, previous_epoch)
       when is_integer(previous_epoch) and previous_epoch == 0 do
    {:ok,
     %MlsGroupInfo{}
     |> MlsGroupInfo.changeset(attrs)
     |> Repo.insert!()}
  end

  defp apply_group_info_publish(nil, _attrs, _new_epoch, previous_epoch)
       when is_integer(previous_epoch) do
    {:error, :epoch_conflict}
  end

  defp apply_group_info_publish(
         %MlsGroupInfo{epoch: stored} = existing,
         attrs,
         _new_epoch,
         previous_epoch
       )
       when is_integer(previous_epoch) and stored == previous_epoch do
    {:ok,
     existing
     |> MlsGroupInfo.changeset(attrs)
     |> Repo.update!()}
  end

  defp apply_group_info_publish(%MlsGroupInfo{epoch: stored}, _attrs, new_epoch, previous_epoch)
       when is_integer(previous_epoch) do
    Logger.warning(
      "MLS epoch_conflict: stored=#{stored}, new=#{new_epoch}, previous=#{previous_epoch}"
    )

    {:error, :epoch_conflict}
  end

  defp apply_group_info_publish(nil, attrs, _new_epoch, _previous_epoch) do
    {:ok,
     %MlsGroupInfo{}
     |> MlsGroupInfo.changeset(attrs)
     |> Repo.insert!()}
  end

  defp apply_group_info_publish(
         %MlsGroupInfo{epoch: stored} = existing,
         attrs,
         new_epoch,
         _previous_epoch
       )
       when new_epoch > stored and new_epoch - stored <= @max_epoch_delta do
    {:ok,
     existing
     |> MlsGroupInfo.changeset(attrs)
     |> Repo.update!()}
  end

  # Epoch jump exceeds max delta — reject to prevent inflation attacks
  defp apply_group_info_publish(
         %MlsGroupInfo{epoch: stored},
         _attrs,
         new_epoch,
         _previous_epoch
       )
       when new_epoch > stored do
    {:error, :epoch_delta_exceeded}
  end

  defp apply_group_info_publish(
         %MlsGroupInfo{} = existing,
         attrs,
         new_epoch,
         _previous_epoch
       )
       when new_epoch == existing.epoch do
    if same_group_info_payload?(existing, attrs) do
      {:ok, existing}
    else
      {:ok, existing}
    end
  end

  defp apply_group_info_publish(%MlsGroupInfo{} = existing, _attrs, _new_epoch, _previous_epoch) do
    {:ok, existing}
  end

  defp existing_external_commit_success(existing, attrs, new_epoch, commit_attrs) do
    if existing &&
         existing.epoch == new_epoch &&
         same_group_info_payload?(existing, attrs) do
      expected_payload = Map.fetch!(commit_attrs, :payload)

      case fetch_mls_commit_event_by_idempotency_key(commit_attrs) do
        %MlsEvent{payload: payload} = event when payload == expected_payload ->
          {:ok, %{group_info: existing, event: event}}

        %MlsEvent{} ->
          :error

        nil ->
          nil
      end
    end
  end

  defp existing_sponsored_transition_success(
         existing,
         attrs,
         new_epoch,
         commit_attrs,
         recipient_id,
         recipient_client_id
       ) do
    cond do
      # Exact match: same epoch + same payload = idempotent retry
      existing && existing.epoch == new_epoch && same_group_info_payload?(existing, attrs) ->
        expected_payload = Map.fetch!(commit_attrs, :payload)

        case fetch_mls_commit_event_by_idempotency_key(commit_attrs) do
          %MlsEvent{payload: payload} = commit_event when payload == expected_payload ->
            {:ok,
             %{
               fresh: false,
               commit_event: commit_event,
               remove_event: nil,
               welcome:
                 fetch_pending_welcome_for_scope(
                   recipient_id,
                   existing.group_id,
                   recipient_client_id
                 )
             }}

          %MlsEvent{} ->
            :error

          nil ->
            nil
        end

      # Epoch already advanced past our target: a prior attempt or concurrent
      # operation already published at this epoch. Treat as success if the
      # commit event exists (the sponsored transition was applied).
      existing && existing.epoch >= new_epoch ->
        case fetch_mls_commit_event_by_idempotency_key(commit_attrs) do
          %MlsEvent{} = commit_event ->
            {:ok,
             %{
               fresh: false,
               commit_event: commit_event,
               remove_event: nil,
               welcome:
                 fetch_pending_welcome_for_scope(
                   recipient_id,
                   existing.group_id,
                   recipient_client_id
                 )
             }}

          nil ->
            nil
        end

      true ->
        nil
    end
  end

  defp same_group_info_payload?(%MlsGroupInfo{} = existing, attrs) do
    existing.group_info_data ==
      (Map.get(attrs, :group_info_data) || Map.get(attrs, "group_info_data")) &&
      existing.ratchet_tree_data ==
        (Map.get(attrs, :ratchet_tree_data) || Map.get(attrs, "ratchet_tree_data")) &&
      existing.epoch == (Map.get(attrs, :epoch) || Map.get(attrs, "epoch") || 0)
  end

  defp lock_group_info_publish(group_id) when is_binary(group_id) do
    Repo.query!("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [group_id])
    :ok
  end

  defp lock_group_info_publish(_group_id), do: :ok

  @doc """
  Fetch the latest MLS GroupInfo for a scope by group_id.
  """
  def get_group_info(group_id) do
    from(gi in MlsGroupInfo,
      where: gi.group_id == ^group_id
    )
    |> Repo.one()
  end

  @doc """
  Delete MLS GroupInfo for a scope (e.g., when the group is dissolved).
  """
  def delete_group_info(group_id) do
    from(gi in MlsGroupInfo,
      where: gi.group_id == ^group_id
    )
    |> Repo.delete_all()
  end
end
