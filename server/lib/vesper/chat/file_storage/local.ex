defmodule Vesper.Chat.FileStorage.Local do
  @moduledoc """
  Local filesystem storage backend.
  Files are stored by SHA256 hash for deduplication.
  """

  @behaviour Vesper.Chat.FileStorage.Behaviour

  @upload_dir "priv/uploads"

  @impl true
  def store(source_path, _original_filename) do
    ensure_upload_dir!()

    hash = hash_file(source_path)
    dest = Path.join(upload_dir(), hash)

    unless File.exists?(dest) do
      File.cp!(source_path, dest)
    end

    {:ok, hash}
  rescue
    e -> {:error, Exception.message(e)}
  end

  @impl true
  def ensure_stored(source_path, _original_filename, storage_key) do
    ensure_upload_dir!()
    destination = Path.join(upload_dir(), storage_key)
    unless File.exists?(destination), do: File.cp!(source_path, destination)
    :ok
  rescue
    error -> {:error, Exception.message(error)}
  end

  @impl true
  def get_path(storage_key) do
    Path.join(upload_dir(), storage_key)
  end

  @impl true
  def delete(storage_key) do
    path = get_path(storage_key)
    if File.exists?(path), do: File.rm!(path)
    :ok
  end

  @impl true
  def max_upload_size do
    Application.get_env(:vesper, :max_upload_size, 52_428_800)
  end

  @impl true
  def avatar_dir do
    Path.join(upload_dir(), "avatars")
  end

  @impl true
  def banner_dir do
    Path.join(upload_dir(), "banners")
  end

  @impl true
  def emoji_dir(server_id) do
    Path.join([upload_dir(), "emojis", server_id])
  end

  @impl true
  def emoji_path(server_id, storage_key) do
    Path.join(emoji_dir(server_id), storage_key)
  end

  @impl true
  def store_server_emoji(source_path, server_id, storage_key) do
    dir = emoji_dir(server_id)
    File.mkdir_p!(dir)
    File.cp!(source_path, Path.join(dir, storage_key))
    :ok
  rescue
    e -> {:error, Exception.message(e)}
  end

  @impl true
  def delete_server_emoji(server_id, storage_key) do
    path = emoji_path(server_id, storage_key)
    if File.exists?(path), do: File.rm!(path)
    :ok
  end

  @impl true
  def delete_existing_avatar(user_id) do
    dir = avatar_dir()

    ~w(.jpg .png .gif .webp)
    |> Enum.each(fn ext ->
      path = Path.join(dir, "#{user_id}#{ext}")
      if File.exists?(path), do: File.rm!(path)
    end)
  end

  @impl true
  def server_icon_dir do
    Path.join(upload_dir(), "server_icons")
  end

  @impl true
  def delete_existing_server_icon(server_id) do
    dir = server_icon_dir()

    ~w(.jpg .png .gif .webp)
    |> Enum.each(fn ext ->
      path = Path.join(dir, "#{server_id}#{ext}")
      if File.exists?(path), do: File.rm!(path)
    end)
  end

  @impl true
  def delete_existing_banner(user_id) do
    dir = banner_dir()

    ~w(.jpg .png .gif .webp)
    |> Enum.each(fn ext ->
      path = Path.join(dir, "#{user_id}#{ext}")
      if File.exists?(path), do: File.rm!(path)
    end)
  end

  defp upload_dir do
    Application.get_env(:vesper, :upload_dir) || Application.app_dir(:vesper, @upload_dir)
  end

  defp ensure_upload_dir! do
    File.mkdir_p!(upload_dir())
  end

  defp hash_file(path) do
    path
    |> File.stream!(2048)
    |> Enum.reduce(:crypto.hash_init(:sha256), &:crypto.hash_update(&2, &1))
    |> :crypto.hash_final()
    |> Base.encode16(case: :lower)
  end
end
