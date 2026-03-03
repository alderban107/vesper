defmodule Vesper.Workers.ExpireAttachmentBlobs do
  @moduledoc """
  Oban worker that cleans up expired and orphaned attachments.
  Runs daily at 3am via crontab.

  1. Deletes attachment records where expires_at has passed
  2. Deletes orphaned attachments (null message_id, older than 1 hour)
  3. Removes disk blobs with no remaining attachment references
  """
  use Oban.Worker, queue: :default, max_attempts: 3
  import Ecto.Query
  require Logger

  alias Vesper.Repo
  alias Vesper.Chat.{Attachment, FileStorage}

  @impl Oban.Worker
  def perform(_job) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)
    one_hour_ago = DateTime.add(now, -3600, :second)

    # Collect storage keys from attachments we're about to delete
    expired_keys =
      from(a in Attachment,
        where: not is_nil(a.expires_at) and a.expires_at < ^now,
        select: a.storage_key
      )
      |> Repo.all()

    orphan_keys =
      from(a in Attachment,
        where: is_nil(a.message_id) and a.inserted_at < ^one_hour_ago,
        select: a.storage_key
      )
      |> Repo.all()

    all_keys = Enum.uniq(expired_keys ++ orphan_keys)

    # Delete expired attachment records
    {expired_count, _} =
      from(a in Attachment,
        where: not is_nil(a.expires_at) and a.expires_at < ^now
      )
      |> Repo.delete_all()

    # Delete orphaned attachment records (uploaded but never linked to a message)
    {orphan_count, _} =
      from(a in Attachment,
        where: is_nil(a.message_id) and a.inserted_at < ^one_hour_ago
      )
      |> Repo.delete_all()

    # Clean disk blobs where no attachment record references them anymore
    blob_count =
      Enum.reduce(all_keys, 0, fn key, acc ->
        remaining =
          from(a in Attachment, where: a.storage_key == ^key)
          |> Repo.aggregate(:count, :id)

        if remaining == 0 do
          FileStorage.delete(key)
          acc + 1
        else
          acc
        end
      end)

    total = expired_count + orphan_count
    if total > 0 or blob_count > 0 do
      Logger.info("Attachment cleanup: #{expired_count} expired, #{orphan_count} orphaned records; #{blob_count} blobs removed")
    end

    :ok
  end
end
