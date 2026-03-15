defmodule Vesper.Accounts do
  import Ecto.Query
  alias Vesper.Repo
  alias Vesper.Accounts.{SearchIndexSnapshot, User, UserToken, Token}

  def get_user(id), do: Repo.get(User, id)

  def get_user_by_username(username) do
    Repo.get_by(User, username: username)
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

  def create_tokens(user) do
    with {:ok, access_token, _claims} <- Token.generate_access_token(user) do
      refresh_token_record = UserToken.build_refresh_token(user)
      Repo.insert!(refresh_token_record)

      {:ok,
       %{
         access_token: access_token,
         refresh_token: Base.url_encode64(refresh_token_record.token),
         expires_in: Token.access_token_ttl()
       }}
    end
  end

  def refresh_tokens(refresh_token_b64) do
    with {:ok, raw_token} <- Base.url_decode64(refresh_token_b64),
         token_record when not is_nil(token_record) <-
           Repo.one(UserToken.valid_refresh_token_query(raw_token)),
         user when not is_nil(user) <- get_user(token_record.user_id) do
      # Rotate: delete old token, create new pair
      Repo.delete!(token_record)
      create_tokens(user)
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
end
