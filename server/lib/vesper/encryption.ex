defmodule Vesper.Encryption do
  @moduledoc """
  Context for MLS key package directory and pending Welcome storage.
  The server is a dumb relay — it stores encrypted blobs without access to plaintext.
  """

  import Ecto.Query
  alias Vesper.Repo

  alias Vesper.Encryption.{
    KeyPackage,
    MlsEvent,
    PendingCryptoEviction,
    PendingHistoryBundle,
    PendingHistoryRequest,
    PendingResyncRequest,
    PendingWelcome
  }

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
      recipient_id = Map.get(attrs, :recipient_id) || Map.get(attrs, "recipient_id")
      group_id = Map.get(attrs, :group_id) || Map.get(attrs, "group_id")

      recipient_client_id =
        Map.get(attrs, :recipient_client_id) || Map.get(attrs, "recipient_client_id")

      if recipient_id && group_id do
        query =
          from(
            pw in PendingWelcome,
            where: pw.recipient_id == ^recipient_id and pw.group_id == ^group_id
          )

        query =
          case recipient_client_id do
            client_id when is_binary(client_id) and byte_size(client_id) > 0 ->
              from(
                pw in query,
                where: pw.recipient_client_id == ^client_id or is_nil(pw.recipient_client_id)
              )

            _ ->
              from(pw in query, where: is_nil(pw.recipient_client_id))
          end

        Repo.delete_all(query)
      end

      changeset = PendingWelcome.changeset(%PendingWelcome{}, attrs)

      case Repo.insert(changeset) do
        {:ok, welcome} -> welcome
        {:error, changeset} -> Repo.rollback(changeset)
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

    channel_id = Map.get(attrs, :channel_id) || Map.get(attrs, "channel_id")
    conversation_id = Map.get(attrs, :conversation_id) || Map.get(attrs, "conversation_id")

    %PendingHistoryRequest{}
    |> PendingHistoryRequest.changeset(attrs)
    |> Repo.insert(
      on_conflict: [
        set: [
          requester_username: requester_username,
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
  """
  def delete_pending_resync_request(id) do
    from(pr in PendingResyncRequest, where: pr.id == ^id)
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
  Store a replayable MLS remove event and atomically complete any linked crypto eviction.
  """
  def store_mls_remove_event(attrs, crypto_eviction \\ nil) do
    Repo.transaction(fn ->
      with {:ok, event} <- insert_mls_event(attrs),
           :ok <- maybe_complete_pending_crypto_eviction(crypto_eviction, event.id) do
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
    claimed_cutoff = DateTime.add(now, -15, :second)

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
                    (is_nil(eviction.claimed_at) or eviction.claimed_at < ^claimed_cutoff))),
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
        sponsor_device_id
      ) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    Repo.transaction(fn ->
      case lock_crypto_eviction(id, scope_kind, scope_id) do
        nil ->
          Repo.rollback(:not_found)

        %PendingCryptoEviction{target_user_id: target_user_id}
        when target_user_id == sponsor_user_id ->
          Repo.rollback(:target_cannot_sponsor)

        %PendingCryptoEviction{status: status} = eviction
        when status in ["pending", "requested", "claimed"] ->
          {:ok, claimed} =
            eviction
            |> PendingCryptoEviction.changeset(%{
              status: "claimed",
              sponsor_user_id: sponsor_user_id,
              sponsor_device_id: sponsor_device_id,
              claimed_at: now
            })
            |> Repo.update()

          claimed

        _eviction ->
          Repo.rollback(:not_claimable)
      end
    end)
    |> case do
      {:ok, eviction} -> {:ok, eviction}
      {:error, reason} -> {:error, reason}
    end
  end

  def complete_pending_crypto_eviction(
        id,
        scope_kind,
        scope_id,
        removed_user_id,
        removed_device_id,
        commit_event_id,
        sponsor_user_id,
        sponsor_device_id
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

          eviction.status not in ["pending", "requested", "claimed"] ->
            {:error, :not_claimable}

          eviction.status == "claimed" and
              (eviction.sponsor_user_id != sponsor_user_id or
                 eviction.sponsor_device_id != sponsor_device_id) ->
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

            eviction.status not in ["pending", "requested", "claimed"] ->
              Repo.rollback(:not_claimable)

            eviction.status == "claimed" and
                (eviction.sponsor_user_id != sponsor_user_id or
                   eviction.sponsor_device_id != sponsor_device_id) ->
              Repo.rollback(:sponsor_mismatch)

            true ->
              {:ok, applied} =
                eviction
                |> PendingCryptoEviction.changeset(%{
                  status: "applied",
                  sponsor_user_id: sponsor_user_id,
                  sponsor_device_id: sponsor_device_id,
                  applied_at: now,
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
end
