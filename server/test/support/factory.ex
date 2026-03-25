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

  def insert_device(user, attrs \\ %{}) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    defaults = %{
      id: Ecto.UUID.generate(),
      user_id: user.id,
      client_id: "client-#{System.unique_integer([:positive])}",
      name: "Test Device",
      platform: "test",
      trust_state: "trusted",
      trusted_at: now,
      last_seen_at: now,
      inserted_at: now,
      updated_at: now
    }

    Repo.insert!(struct(Vesper.Accounts.Device, Map.merge(defaults, Enum.into(attrs, %{}))))
  end

  def insert_membership(user, server, attrs \\ %{}) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    defaults = %{
      id: Ecto.UUID.generate(),
      user_id: user.id,
      server_id: server.id,
      role: "member",
      joined_at: now,
      inserted_at: now,
      updated_at: now
    }

    Repo.insert!(struct(Vesper.Servers.Membership, Map.merge(defaults, Enum.into(attrs, %{}))))
  end

  def insert_role(server, attrs \\ %{}) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    defaults = %{
      id: Ecto.UUID.generate(),
      server_id: server.id,
      name: "role_#{System.unique_integer([:positive])}",
      permissions: 0,
      position: 0,
      inserted_at: now,
      updated_at: now
    }

    Repo.insert!(struct(Vesper.Servers.Role, Map.merge(defaults, Enum.into(attrs, %{}))))
  end

  def insert_member_role(membership, role) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    Repo.insert!(%Vesper.Servers.MemberRole{
      id: Ecto.UUID.generate(),
      membership_id: membership.id,
      role_id: role.id,
      inserted_at: now,
      updated_at: now
    })
  end

  def insert_channel_role_permission(channel, role, attrs \\ %{}) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    defaults = %{
      id: Ecto.UUID.generate(),
      channel_id: channel.id,
      role_id: role.id,
      allow: 0,
      deny: 0,
      inserted_at: now,
      updated_at: now
    }

    Repo.insert!(
      struct(Vesper.Servers.ChannelRolePermission, Map.merge(defaults, Enum.into(attrs, %{})))
    )
  end

  def insert_channel_user_permission(channel, user, attrs \\ %{}) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    defaults = %{
      id: Ecto.UUID.generate(),
      channel_id: channel.id,
      user_id: user.id,
      allow: 0,
      deny: 0,
      inserted_at: now,
      updated_at: now
    }

    Repo.insert!(
      struct(Vesper.Servers.ChannelUserPermission, Map.merge(defaults, Enum.into(attrs, %{})))
    )
  end
end
