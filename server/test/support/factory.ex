defmodule Vesper.Factory do
  @moduledoc """
  Minimal test factory for inserting records with sane defaults.
  """

  alias Vesper.Repo

  def insert_user(attrs \\ %{}) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    defaults = %{
      id: Ecto.UUID.generate(),
      username: "user_#{System.unique_integer([:positive])}",
      password_hash: Argon2.hash_pwd_salt("testpassword"),
      inserted_at: now,
      updated_at: now
    }

    merged = Map.merge(defaults, attrs)
    Repo.insert!(struct(Vesper.Accounts.User, merged))
  end

  def insert_server(owner, attrs \\ %{}) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    defaults = %{
      id: Ecto.UUID.generate(),
      name: "server_#{System.unique_integer([:positive])}",
      owner_id: owner.id,
      invite_code: Base.url_encode64(:crypto.strong_rand_bytes(6)),
      invite_code_rotated_at: now,
      inserted_at: now,
      updated_at: now
    }

    merged = Map.merge(defaults, attrs)
    Repo.insert!(struct(Vesper.Servers.Server, merged))
  end

  def insert_channel(server, attrs \\ %{}) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    defaults = %{
      id: Ecto.UUID.generate(),
      name: "channel_#{System.unique_integer([:positive])}",
      type: "text",
      server_id: server.id,
      inserted_at: now,
      updated_at: now
    }

    merged = Map.merge(defaults, attrs)
    Repo.insert!(struct(Vesper.Servers.Channel, merged))
  end

  def insert_message(sender, channel, attrs \\ %{}) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    defaults = %{
      id: Ecto.UUID.generate(),
      content: "",
      ciphertext: <<0>>,
      mls_epoch: 0,
      sender_id: sender.id,
      channel_id: channel.id,
      inserted_at: now,
      updated_at: now
    }

    merged = Map.merge(defaults, attrs)
    Repo.insert!(struct(Vesper.Chat.Message, merged))
  end

  @doc """
  Creates a file on disk at the FileStorage path and inserts a matching
  attachment record linked to the given message. Returns the attachment
  and storage key.
  """
  def insert_attachment_with_file(message, attrs \\ %{})

  def insert_attachment_with_file(message, attrs) when is_list(attrs) do
    insert_attachment_with_file(message, Map.new(attrs))
  end

  def insert_attachment_with_file(message, attrs) when is_map(attrs) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)
    storage_key = attrs[:storage_key] || random_storage_key()

    # Write the blob to disk
    path = Vesper.Chat.FileStorage.get_path(storage_key)
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, attrs[:file_content] || "test file content #{storage_key}")

    defaults = %{
      id: Ecto.UUID.generate(),
      filename: "test_file.txt",
      content_type: "text/plain",
      size_bytes: File.stat!(path).size,
      storage_key: storage_key,
      message_id: message.id,
      encrypted: false,
      inserted_at: now
    }

    merged = Map.merge(defaults, Map.drop(attrs, [:file_content]))
    attachment = Repo.insert!(struct(Vesper.Chat.Attachment, merged))
    {attachment, storage_key}
  end

  defp random_storage_key do
    :crypto.strong_rand_bytes(32) |> Base.encode16(case: :lower)
  end
end
