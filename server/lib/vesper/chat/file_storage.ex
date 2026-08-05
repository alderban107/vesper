defmodule Vesper.Chat.FileStorage do
  @moduledoc """
  Storage dispatcher. Delegates to the configured backend.

  Configure via:

      config :vesper, :file_storage_backend, Vesper.Chat.FileStorage.Local

  Defaults to `Vesper.Chat.FileStorage.Local` (local filesystem).
  """

  @behaviour Vesper.Chat.FileStorage.Behaviour

  defp backend do
    Application.get_env(:vesper, :file_storage_backend, Vesper.Chat.FileStorage.Local)
  end

  @impl true
  def store(source_path, original_filename), do: backend().store(source_path, original_filename)

  @impl true
  def ensure_stored(source_path, original_filename, storage_key),
    do: backend().ensure_stored(source_path, original_filename, storage_key)

  @impl true
  def get_path(storage_key), do: backend().get_path(storage_key)

  @impl true
  def delete(storage_key), do: backend().delete(storage_key)

  @impl true
  def max_upload_size, do: backend().max_upload_size()

  @impl true
  def avatar_dir, do: backend().avatar_dir()

  @impl true
  def banner_dir, do: backend().banner_dir()

  @impl true
  def emoji_dir(server_id), do: backend().emoji_dir(server_id)

  @impl true
  def emoji_path(server_id, storage_key), do: backend().emoji_path(server_id, storage_key)

  @impl true
  def store_server_emoji(source_path, server_id, storage_key),
    do: backend().store_server_emoji(source_path, server_id, storage_key)

  @impl true
  def delete_server_emoji(server_id, storage_key),
    do: backend().delete_server_emoji(server_id, storage_key)

  @impl true
  def delete_existing_avatar(user_id), do: backend().delete_existing_avatar(user_id)

  @impl true
  def delete_existing_banner(user_id), do: backend().delete_existing_banner(user_id)

  @impl true
  def delete_existing_server_icon(server_id),
    do: backend().delete_existing_server_icon(server_id)

  @impl true
  def server_icon_dir, do: backend().server_icon_dir()
end
