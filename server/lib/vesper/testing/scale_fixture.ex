defmodule Vesper.Testing.ScaleFixture do
  alias Vesper.Accounts.{Device, User}
  alias Vesper.Repo
  alias Vesper.Runtime.Room
  alias Vesper.Servers.{Channel, Membership, Server}

  @default_password "vesper-sdk-chaos-password"
  @insert_chunk_size 500

  def build(attrs) when is_map(attrs) do
    label = normalize_label(Map.get(attrs, :label) || Map.get(attrs, "label") || "chaos")
    nonce = Map.get(attrs, :nonce) || Map.get(attrs, "nonce") || short_nonce()
    user_count = positive_integer!(Map.get(attrs, :user_count) || Map.get(attrs, "user_count"))
    channel_count = positive_integer!(Map.get(attrs, :channel_count) || Map.get(attrs, "channel_count"))

    active_channel_count =
      attrs
      |> Map.get(:active_channel_count, Map.get(attrs, "active_channel_count", channel_count))
      |> positive_integer!()
      |> min(channel_count)

    secondary_every =
      attrs
      |> Map.get(:secondary_every, Map.get(attrs, "secondary_every", 0))
      |> non_negative_integer!()

    password = Map.get(attrs, :password) || Map.get(attrs, "password") || @default_password
    now = DateTime.utc_now() |> DateTime.truncate(:second)
    password_hash = Argon2.hash_pwd_salt(password)

    owner = owner_fixture(label, nonce, password, password_hash, now)
    server = server_fixture(owner, label, nonce, now)
    channels = channel_fixtures(server.id, label, nonce, channel_count, now)
    rooms = room_fixtures(server.id, channels, now)
    users = user_fixtures(label, nonce, user_count, password, password_hash, secondary_every, now)
    memberships = membership_fixtures(server.id, owner, users, now)

    Repo.transaction(fn ->
      Repo.insert!(struct(User, owner.user))
      Repo.insert!(struct(Device, owner.primary_device))
      Repo.insert!(struct(Server, server))

      insert_all_in_chunks(User, Enum.map(users, & &1.user))
      insert_all_in_chunks(Device, users |> Enum.flat_map(&device_entries/1))
      insert_all_in_chunks(Membership, memberships)
      insert_all_in_chunks(Channel, channels)
      insert_all_in_chunks(Room, rooms)
    end)

    %{
      active_channel_ids: channels |> Enum.take(active_channel_count) |> Enum.map(& &1.id),
      channel_count: channel_count,
      label: label,
      nonce: nonce,
      owner: %{
        device_id: owner.primary_device.client_id,
        password: password,
        username: owner.user.username
      },
      password: password,
      secondary_every: secondary_every,
      server: %{
        id: server.id,
        invite_code: server.invite_code,
        name: server.name
      },
      user_count: user_count,
      users:
        Enum.map(users, fn user ->
          %{
            primary_device_id: user.primary_device.client_id,
            secondary_device_id:
              if(user.secondary_device, do: user.secondary_device.client_id, else: nil),
            username: user.user.username
          }
        end)
    }
  end

  defp owner_fixture(label, nonce, password, password_hash, now) do
    username = "#{label}_owner_#{nonce}"
    device_id = "#{label}-owner-#{nonce}-primary"

    %{
      primary_device: %{
        id: Ecto.UUID.generate(),
        approval_method: "registration",
        client_id: device_id,
        inserted_at: now,
        last_seen_at: now,
        name: "Scale Fixture Owner",
        platform: "seeded",
        revoked_at: nil,
        trust_state: "trusted",
        trusted_at: now,
        updated_at: now,
        user_id: nil
      },
      user: %{
        id: Ecto.UUID.generate(),
        inserted_at: now,
        password_hash: password_hash,
        recovery_key_hash: "#{label}-owner-recovery-#{nonce}",
        updated_at: now,
        username: username
      },
      password: password
    }
    |> attach_owner_device()
  end

  defp attach_owner_device(%{user: user, primary_device: primary_device} = owner) do
    %{owner | primary_device: %{primary_device | user_id: user.id}}
  end

  defp server_fixture(owner, label, nonce, now) do
    %{
      id: Ecto.UUID.generate(),
      inserted_at: now,
      invite_code: Base.url_encode64(:crypto.strong_rand_bytes(9), padding: false),
      invite_code_rotated_at: now,
      name: "Scale #{String.upcase(label)} #{nonce}",
      owner_id: owner.user.id,
      updated_at: now
    }
  end

  defp channel_fixtures(server_id, label, nonce, count, now) do
    Enum.map(0..(count - 1), fn index ->
      %{
        id: Ecto.UUID.generate(),
        inserted_at: now,
        name: "#{label}-#{nonce}-#{index + 1}",
        position: index,
        server_id: server_id,
        topic: nil,
        type: "text",
        updated_at: now
      }
    end)
  end

  defp room_fixtures(server_id, channels, now) do
    Enum.map(channels, fn channel ->
      %{
        channel_id: channel.id,
        conversation_id: nil,
        current_seq: 0,
        id: Ecto.UUID.generate(),
        inserted_at: now,
        kind: :channel,
        last_message_at: nil,
        last_message_id: nil,
        last_message_seq: nil,
        last_mutation_at: nil,
        last_mutation_seq: nil,
        server_id: server_id,
        updated_at: now
      }
    end)
  end

  defp user_fixtures(label, nonce, user_count, _password, password_hash, secondary_every, now) do
    Enum.map(0..(user_count - 1), fn index ->
      username = "#{label}_#{nonce}_#{Integer.to_string(index, 36)}"
      user_id = Ecto.UUID.generate()
      primary_device_id = "#{label}-#{nonce}-u#{index}-primary"

      secondary_device =
        if secondary_every > 0 and rem(index, secondary_every) == 0 do
          %{
            id: Ecto.UUID.generate(),
            approval_method: "trusted_device",
            client_id: "#{label}-#{nonce}-u#{index}-secondary",
            inserted_at: now,
            last_seen_at: now,
            name: "Scale Fixture #{index} Secondary",
            platform: "seeded",
            revoked_at: nil,
            trust_state: "trusted",
            trusted_at: now,
            updated_at: now,
            user_id: user_id
          }
        else
          nil
        end

      %{
        primary_device: %{
          id: Ecto.UUID.generate(),
          approval_method: "registration",
          client_id: primary_device_id,
          inserted_at: now,
          last_seen_at: now,
          name: "Scale Fixture #{index} Primary",
          platform: "seeded",
          revoked_at: nil,
          trust_state: "trusted",
          trusted_at: now,
          updated_at: now,
          user_id: user_id
        },
        secondary_device: secondary_device,
        user: %{
          id: user_id,
          inserted_at: now,
          password_hash: password_hash,
          recovery_key_hash: "#{label}-#{nonce}-recovery-#{index}",
          updated_at: now,
          username: username
        }
      }
    end)
  end

  defp membership_fixtures(server_id, owner, users, now) do
    owner_membership = %{
      id: Ecto.UUID.generate(),
      joined_at: now,
      role: "owner",
      server_id: server_id,
      user_id: owner.user.id
    }

    user_memberships =
      Enum.map(users, fn user ->
        %{
          id: Ecto.UUID.generate(),
          joined_at: now,
          role: "member",
          server_id: server_id,
          user_id: user.user.id
        }
      end)

    [owner_membership | user_memberships]
  end

  defp device_entries(user_fixture) do
    [user_fixture.primary_device] ++ if(user_fixture.secondary_device, do: [user_fixture.secondary_device], else: [])
  end

  defp insert_all_in_chunks(_schema, []), do: :ok

  defp insert_all_in_chunks(schema, entries) do
    Enum.chunk_every(entries, @insert_chunk_size)
    |> Enum.each(fn chunk ->
      Repo.insert_all(schema, chunk)
    end)

    :ok
  end

  defp normalize_label(value) when is_binary(value) do
    value
    |> String.downcase()
    |> String.replace(~r/[^a-z0-9]+/u, "_")
    |> String.trim("_")
    |> case do
      "" -> "chaos"
      normalized -> String.slice(normalized, 0, 12)
    end
  end

  defp normalize_label(_value), do: "chaos"

  defp positive_integer!(value) when is_integer(value) and value > 0, do: value
  defp positive_integer!(value) when is_binary(value), do: value |> String.to_integer() |> positive_integer!()
  defp positive_integer!(_value), do: raise(ArgumentError, "expected a positive integer")

  defp non_negative_integer!(value) when is_integer(value) and value >= 0, do: value

  defp non_negative_integer!(value) when is_binary(value) do
    value
    |> String.to_integer()
    |> non_negative_integer!()
  end

  defp non_negative_integer!(_value), do: raise(ArgumentError, "expected a non-negative integer")

  defp short_nonce do
    System.unique_integer([:positive])
    |> Integer.to_string(36)
  end
end
