defmodule Vesper.Encryption do
  @moduledoc """
  Context for MLS key package directory and pending Welcome storage.
  The server is a dumb relay — it stores encrypted blobs without access to plaintext.
  """

  import Ecto.Query
  alias Vesper.Repo

  alias Vesper.Encryption.{
    KeyPackage,
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
end
