defmodule Vesper.Encryption do
  @moduledoc """
  Context for MLS key package directory and pending Welcome storage.
  The server is a dumb relay — it stores encrypted blobs without access to plaintext.
  """

  import Ecto.Query
  alias Vesper.Repo
  alias Vesper.Encryption.{KeyPackage, PendingWelcome}

  # --- Key Packages ---

  @doc """
  Bulk-insert key packages for a user.
  """
  def upload_key_packages(user_id, packages) when is_list(packages) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    entries =
      Enum.map(packages, fn data ->
        %{
          id: Ecto.UUID.generate(),
          user_id: user_id,
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
  def fetch_and_consume_key_package(user_id) do
    Repo.transaction(fn ->
      query =
        from(kp in KeyPackage,
          where: kp.user_id == ^user_id and kp.consumed == false,
          limit: 1,
          lock: "FOR UPDATE SKIP LOCKED"
        )

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
  def count_key_packages(user_id) do
    from(kp in KeyPackage,
      where: kp.user_id == ^user_id and kp.consumed == false,
      select: count()
    )
    |> Repo.one()
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
    %PendingWelcome{}
    |> PendingWelcome.changeset(attrs)
    |> Repo.insert()
  end

  @doc """
  Get all pending Welcomes for a user in a specific channel.
  """
  def get_pending_welcomes(recipient_id, channel_id) do
    from(pw in PendingWelcome,
      where: pw.recipient_id == ^recipient_id and pw.channel_id == ^channel_id,
      order_by: [asc: pw.inserted_at]
    )
    |> Repo.all()
  end

  @doc """
  Get all pending Welcomes for a user (across all channels).
  """
  def get_all_pending_welcomes(recipient_id) do
    from(pw in PendingWelcome,
      where: pw.recipient_id == ^recipient_id,
      order_by: [asc: pw.inserted_at]
    )
    |> Repo.all()
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
end
