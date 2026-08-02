defmodule Vesper.Chat.AttachmentBlobLock do
  @moduledoc false

  import Ecto.Query, only: [from: 2]

  alias Vesper.Chat.{Attachment, FileStorage}
  alias Vesper.Repo

  def with_lock(storage_key, operation)
      when is_binary(storage_key) and is_function(operation, 0) do
    Repo.transaction(fn ->
      lock!(storage_key)
      operation.()
    end)
  end

  def lock!(storage_key) when is_binary(storage_key) do
    Ecto.Adapters.SQL.query!(
      Repo,
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      ["attachment-blob:" <> storage_key]
    )

    :ok
  end

  def delete_if_unreferenced(storage_key) when is_binary(storage_key) do
    case with_lock(storage_key, fn -> delete_if_unreferenced_locked(storage_key) end) do
      {:ok, result} -> result
      {:error, _reason} -> :retained
    end
  rescue
    _ -> :retained
  end

  # The caller must hold this storage key's advisory transaction lock.
  def delete_if_unreferenced_locked(storage_key) when is_binary(storage_key) do
    references =
      Repo.aggregate(
        from(attachment in Attachment, where: attachment.storage_key == ^storage_key),
        :count
      )

    if references == 0 do
      FileStorage.delete(storage_key)
      :deleted
    else
      :retained
    end
  end
end
