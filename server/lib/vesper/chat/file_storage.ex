defmodule Vesper.Chat.FileStorage do
  @moduledoc """
  Local filesystem storage for uploaded files.
  Files are stored by SHA256 hash for deduplication.
  """

  @upload_dir "priv/uploads"

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

  def get_path(storage_key) do
    Path.join(upload_dir(), storage_key)
  end

  def delete(storage_key) do
    path = get_path(storage_key)
    if File.exists?(path), do: File.rm!(path)
    :ok
  end

  def max_upload_size do
    Application.get_env(:vesper, :max_upload_size, 26_214_400)
  end

  def avatar_dir do
    Path.join(upload_dir(), "avatars")
  end

  def delete_existing_avatar(user_id) do
    dir = avatar_dir()

    ~w(.jpg .png .gif .webp)
    |> Enum.each(fn ext ->
      path = Path.join(dir, "#{user_id}#{ext}")
      if File.exists?(path), do: File.rm!(path)
    end)
  end

  defp upload_dir do
    Application.app_dir(:vesper, @upload_dir)
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
