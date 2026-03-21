defmodule Vesper.Encryption do
  @moduledoc """
  Context for pre-key bundle directory (key packages).
  The server is a dumb relay — it stores encrypted blobs without access to plaintext.

  Previously managed MLS state (pending welcomes, resync requests, history bundles,
  durable MLS events, crypto evictions). Those have been removed as part of the
  migration from MLS to Signal Protocol (X3DH + Double Ratchet + Sender Keys).
  """

  import Ecto.Query
  alias Vesper.Repo

  alias Vesper.Encryption.KeyPackage

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

end
