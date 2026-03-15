defmodule Vesper.Accounts do
  import Ecto.Query
  alias Vesper.Repo
  alias Vesper.Accounts.{Device, SearchIndexSnapshot, Token, User, UserToken}

  def get_user(id), do: Repo.get(User, id)

  def get_device(id), do: Repo.get(Device, id)

  def get_user_device(user_id, device_id) do
    Repo.get_by(Device, id: device_id, user_id: user_id)
  end

  def get_user_by_username(username) do
    Repo.get_by(User, username: username)
  end

  def list_devices(user_id) do
    from(d in Device,
      where: d.user_id == ^user_id,
      order_by: [desc: d.inserted_at]
    )
    |> Repo.all()
  end

  def register_user(attrs) do
    %User{}
    |> User.registration_changeset(attrs)
    |> Repo.insert()
  end

  def authenticate_user(username, password) do
    user = get_user_by_username(username)

    if User.verify_password(user, password) do
      {:ok, user}
    else
      {:error, :unauthorized}
    end
  end

  def create_tokens(user, device) do
    with {:ok, access_token, _claims} <- Token.generate_access_token(user, device) do
      refresh_token_record = UserToken.build_refresh_token(user, device)
      Repo.insert!(refresh_token_record)

      {:ok,
       %{
         access_token: access_token,
         refresh_token: Base.url_encode64(refresh_token_record.token),
         expires_in: Token.access_token_ttl(),
         current_device: device
       }}
    end
  end

  def refresh_tokens(refresh_token_b64) do
    with {:ok, raw_token} <- Base.url_decode64(refresh_token_b64),
         token_record when not is_nil(token_record) <-
           Repo.one(UserToken.valid_refresh_token_query(raw_token)),
         user when not is_nil(user) <- get_user(token_record.user_id),
         device when not is_nil(device) <- get_user_device(user.id, token_record.device_id),
         false <- device_revoked?(device) do
      # Rotate: delete old token, create new pair
      Repo.delete!(token_record)
      touch_device(device)
      create_tokens(user, device)
    else
      _ -> {:error, :invalid_token}
    end
  end

  def revoke_refresh_token(refresh_token_b64) do
    with {:ok, raw_token} <- Base.url_decode64(refresh_token_b64) do
      from(t in UserToken, where: t.token == ^raw_token and t.context == "refresh")
      |> Repo.delete_all()

      :ok
    else
      _ -> :ok
    end
  end

  def revoke_all_user_tokens(user_id) do
    from(t in UserToken, where: t.user_id == ^user_id)
    |> Repo.delete_all()

    :ok
  end

  def revoke_device_tokens(device_id) do
    from(t in UserToken, where: t.device_id == ^device_id)
    |> Repo.delete_all()

    :ok
  end

  def update_profile(user, attrs) do
    user
    |> User.profile_changeset(attrs)
    |> Repo.update()
  end

  def update_key_bundle(user, attrs) do
    user
    |> User.crypto_changeset(attrs)
    |> Repo.update()
  end

  def ensure_device(user, attrs, trust_state, approval_method \\ nil) do
    client_id = attrs[:client_id]
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    case Repo.get_by(Device, user_id: user.id, client_id: client_id) do
      nil ->
        %Device{}
        |> Device.changeset(%{
          user_id: user.id,
          client_id: client_id,
          name: attrs[:name],
          platform: attrs[:platform],
          trust_state: trust_state,
          approval_method: approval_method,
          trusted_at: if(trust_state == "trusted", do: now),
          revoked_at: if(trust_state == "revoked", do: now),
          last_seen_at: now
        })
        |> Repo.insert()

      %Device{} = device ->
        device
        |> Device.changeset(%{
          name: attrs[:name] || device.name,
          platform: attrs[:platform] || device.platform,
          trust_state: normalize_existing_trust_state(device, trust_state),
          approval_method: approval_method || device.approval_method,
          trusted_at: trusted_at_for_update(device, trust_state, now),
          revoked_at: revoked_at_for_update(device, trust_state, now),
          last_seen_at: now
        })
        |> Repo.update()
    end
  end

  def approve_device(user_id, device_id, approval_method \\ "trusted_device") do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    case get_user_device(user_id, device_id) do
      nil ->
        {:error, :not_found}

      %Device{} = device ->
        device
        |> Device.changeset(%{
          trust_state: "trusted",
          approval_method: approval_method,
          trusted_at: now,
          revoked_at: nil,
          last_seen_at: now
        })
        |> Repo.update()
    end
  end

  def revoke_device(user_id, device_id) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    case get_user_device(user_id, device_id) do
      nil ->
        {:error, :not_found}

      %Device{} = device ->
        result =
          device
          |> Device.changeset(%{
            trust_state: "revoked",
            revoked_at: now
          })
          |> Repo.update()

        if match?({:ok, _}, result) do
          revoke_device_tokens(device_id)
        end

        result
    end
  end

  def approve_current_device_with_recovery(user, device_id, recovery_key_hash) do
    cond do
      user.recovery_key_hash != recovery_key_hash ->
        {:error, :not_found}

      true ->
        approve_device(user.id, device_id, "recovery_key")
    end
  end

  def touch_device(%Device{} = device) do
    device
    |> Device.changeset(%{last_seen_at: DateTime.utc_now() |> DateTime.truncate(:second)})
    |> Repo.update()
  end

  def change_password(user, old_password, new_password, new_bundle_attrs) do
    if User.verify_password(user, old_password) do
      changeset =
        user
        |> User.registration_changeset(%{password: new_password})
        |> Ecto.Changeset.cast(new_bundle_attrs, [
          :encrypted_key_bundle,
          :key_bundle_salt,
          :key_bundle_nonce
        ])

      case Repo.update(changeset) do
        {:ok, updated_user} ->
          revoke_all_user_tokens(user.id)
          {:ok, updated_user}

        error ->
          error
      end
    else
      {:error, :invalid_password}
    end
  end

  def verify_recovery_key(recovery_key_hash) do
    case Repo.one(from(u in User, where: u.recovery_key_hash == ^recovery_key_hash)) do
      nil -> {:error, :not_found}
      user -> {:ok, user}
    end
  end

  def reset_password_with_recovery(recovery_key_hash, new_password, bundle_attrs) do
    case verify_recovery_key(recovery_key_hash) do
      {:ok, user} ->
        changeset =
          user
          |> User.registration_changeset(%{password: new_password})
          |> Ecto.Changeset.cast(bundle_attrs, [
            :encrypted_key_bundle,
            :key_bundle_salt,
            :key_bundle_nonce
          ])

        case Repo.update(changeset) do
          {:ok, updated_user} ->
            revoke_all_user_tokens(user.id)
            {:ok, updated_user}

          error ->
            error
        end

      error ->
        error
    end
  end

  def get_search_index_snapshot(user_id) do
    Repo.get_by(SearchIndexSnapshot, user_id: user_id)
  end

  def upsert_search_index_snapshot(user_id, attrs) do
    expected_version = attrs["expected_version"] || attrs[:expected_version]

    case get_search_index_snapshot(user_id) do
      nil ->
        %SearchIndexSnapshot{}
        |> SearchIndexSnapshot.changeset(%{
          user_id: user_id,
          device_id: attrs["device_id"] || attrs[:device_id],
          version: 1,
          ciphertext: attrs["ciphertext"] || attrs[:ciphertext],
          nonce: attrs["nonce"] || attrs[:nonce]
        })
        |> Repo.insert()
        |> case do
          {:ok, snapshot} ->
            {:ok, snapshot}

          {:error, %Ecto.Changeset{} = changeset} ->
            if unique_user_snapshot_conflict?(changeset) do
              case get_search_index_snapshot(user_id) do
                nil -> {:error, changeset}
                snapshot -> {:error, :conflict, snapshot}
              end
            else
              {:error, changeset}
            end
        end

      %SearchIndexSnapshot{} = snapshot ->
        version_to_match =
          if is_integer(expected_version), do: expected_version, else: snapshot.version

        cond do
          version_to_match != snapshot.version ->
            {:error, :conflict, snapshot}

          true ->
            {updated_count, _} =
              from(s in SearchIndexSnapshot,
                where: s.id == ^snapshot.id and s.version == ^version_to_match
              )
              |> Repo.update_all(
                set: [
                  device_id: attrs["device_id"] || attrs[:device_id],
                  ciphertext: attrs["ciphertext"] || attrs[:ciphertext],
                  nonce: attrs["nonce"] || attrs[:nonce],
                  updated_at: DateTime.utc_now() |> DateTime.truncate(:second)
                ],
                inc: [version: 1]
              )

            if updated_count == 1 do
              {:ok, get_search_index_snapshot(user_id)}
            else
              case get_search_index_snapshot(user_id) do
                nil -> {:error, :conflict, snapshot}
                latest -> {:error, :conflict, latest}
              end
            end
        end
    end
  end

  def delete_search_index_snapshot(user_id) do
    from(snapshot in SearchIndexSnapshot, where: snapshot.user_id == ^user_id)
    |> Repo.delete_all()

    :ok
  end

  defp unique_user_snapshot_conflict?(%Ecto.Changeset{} = changeset) do
    Enum.any?(changeset.errors, fn
      {:user_id, {_message, meta}} -> meta[:constraint] == :unique
      _ -> false
    end)
  end

  defp normalize_existing_trust_state(%Device{trust_state: "trusted"} = device, _trust_state)
       when is_nil(device.revoked_at),
       do: "trusted"

  defp normalize_existing_trust_state(%Device{trust_state: "revoked"}, "trusted"), do: "trusted"
  defp normalize_existing_trust_state(%Device{trust_state: "revoked"}, "pending"), do: "pending"

  defp normalize_existing_trust_state(%Device{trust_state: "revoked"}, _trust_state),
    do: "revoked"

  defp normalize_existing_trust_state(_device, trust_state), do: trust_state

  defp trusted_at_for_update(
         %Device{trust_state: "trusted", trusted_at: trusted_at},
         _trust_state,
         _now
       ),
       do: trusted_at

  defp trusted_at_for_update(_device, "trusted", now), do: now
  defp trusted_at_for_update(%Device{trusted_at: trusted_at}, _trust_state, _now), do: trusted_at

  defp revoked_at_for_update(%Device{trust_state: "revoked"}, "pending", _now), do: nil

  defp revoked_at_for_update(
         %Device{trust_state: "revoked", revoked_at: revoked_at},
         _trust_state,
         _now
       ),
       do: revoked_at

  defp revoked_at_for_update(_device, "revoked", now), do: now
  defp revoked_at_for_update(_device, _trust_state, _now), do: nil

  defp device_revoked?(%Device{} = device) do
    device.trust_state == "revoked" or not is_nil(device.revoked_at)
  end
end
