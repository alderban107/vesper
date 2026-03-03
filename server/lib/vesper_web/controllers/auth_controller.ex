defmodule VesperWeb.AuthController do
  use VesperWeb, :controller
  alias Vesper.Accounts

  def register(conn, %{"username" => _, "password" => _} = params) do
    case Accounts.register_user(params) do
      {:ok, user} ->
        # If crypto fields are provided, store them
        user =
          if params["encrypted_key_bundle"] do
            crypto_attrs = extract_crypto_attrs(params)
            {:ok, updated} = Accounts.update_key_bundle(user, crypto_attrs)
            updated
          else
            user
          end

        {:ok, tokens} = Accounts.create_tokens(user)

        conn
        |> put_status(:created)
        |> json(%{
          user: user_json(user),
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_in: tokens.expires_in
        })

      {:error, changeset} ->
        conn
        |> put_status(:unprocessable_entity)
        |> json(%{errors: format_errors(changeset)})
    end
  end

  def register(conn, _params) do
    conn
    |> put_status(:bad_request)
    |> json(%{error: "username and password are required"})
  end

  def login(conn, %{"username" => username, "password" => password}) do
    case Accounts.authenticate_user(username, password) do
      {:ok, user} ->
        {:ok, tokens} = Accounts.create_tokens(user)

        response = %{
          user: user_json(user),
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_in: tokens.expires_in
        }

        # Include encrypted key bundle if the user has one
        response =
          if user.encrypted_key_bundle do
            Map.merge(response, %{
              encrypted_key_bundle: Base.encode64(user.encrypted_key_bundle),
              key_bundle_salt: Base.encode64(user.key_bundle_salt),
              key_bundle_nonce: Base.encode64(user.key_bundle_nonce)
            })
          else
            response
          end

        json(conn, response)

      {:error, :unauthorized} ->
        conn
        |> put_status(:unauthorized)
        |> json(%{error: "invalid username or password"})
    end
  end

  def login(conn, _params) do
    conn
    |> put_status(:bad_request)
    |> json(%{error: "username and password are required"})
  end

  def refresh(conn, %{"refresh_token" => refresh_token}) do
    case Accounts.refresh_tokens(refresh_token) do
      {:ok, tokens} ->
        json(conn, %{
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_in: tokens.expires_in
        })

      {:error, :invalid_token} ->
        conn
        |> put_status(:unauthorized)
        |> json(%{error: "invalid or expired refresh token"})
    end
  end

  def refresh(conn, _params) do
    conn
    |> put_status(:bad_request)
    |> json(%{error: "refresh_token is required"})
  end

  def logout(conn, %{"refresh_token" => refresh_token}) do
    Accounts.revoke_refresh_token(refresh_token)
    json(conn, %{ok: true})
  end

  def logout(conn, _params) do
    json(conn, %{ok: true})
  end

  def me(conn, _params) do
    json(conn, %{user: user_json(conn.assigns.current_user)})
  end

  def update_profile(conn, params) do
    user = conn.assigns.current_user

    attrs =
      params
      |> Map.take(["display_name", "avatar_url", "status"])
      |> Enum.reduce(%{}, fn {k, v}, acc -> Map.put(acc, String.to_existing_atom(k), v) end)

    case Accounts.update_profile(user, attrs) do
      {:ok, updated_user} ->
        json(conn, %{user: user_json(updated_user)})

      {:error, changeset} ->
        conn
        |> put_status(:unprocessable_entity)
        |> json(%{errors: format_errors(changeset)})
    end
  end

  def change_password(conn, %{
        "old_password" => old_password,
        "new_password" => new_password
      } = params) do
    user = conn.assigns.current_user

    bundle_attrs =
      if params["encrypted_key_bundle"] do
        extract_crypto_attrs(params)
      else
        %{}
      end

    case Accounts.change_password(user, old_password, new_password, bundle_attrs) do
      {:ok, _user} ->
        json(conn, %{ok: true})

      {:error, :invalid_password} ->
        conn
        |> put_status(:unauthorized)
        |> json(%{error: "invalid current password"})

      {:error, changeset} ->
        conn
        |> put_status(:unprocessable_entity)
        |> json(%{errors: format_errors(changeset)})
    end
  end

  def recover(conn, %{"recovery_key_hash" => recovery_key_hash}) do
    case Accounts.verify_recovery_key(recovery_key_hash) do
      {:ok, user} ->
        response =
          if user.encrypted_recovery_bundle do
            %{
              user_id: user.id,
              encrypted_recovery_bundle: Base.encode64(user.encrypted_recovery_bundle)
            }
          else
            %{error: "no recovery bundle found"}
          end

        json(conn, response)

      {:error, :not_found} ->
        conn
        |> put_status(:not_found)
        |> json(%{error: "invalid recovery key"})
    end
  end

  def recover_reset(conn, %{
        "recovery_key_hash" => recovery_key_hash,
        "new_password" => new_password
      } = params) do
    bundle_attrs = extract_crypto_attrs(params)

    case Accounts.reset_password_with_recovery(recovery_key_hash, new_password, bundle_attrs) do
      {:ok, user} ->
        {:ok, tokens} = Accounts.create_tokens(user)

        json(conn, %{
          user: user_json(user),
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_in: tokens.expires_in
        })

      {:error, :not_found} ->
        conn
        |> put_status(:not_found)
        |> json(%{error: "invalid recovery key"})

      {:error, changeset} ->
        conn
        |> put_status(:unprocessable_entity)
        |> json(%{errors: format_errors(changeset)})
    end
  end

  defp user_json(user) do
    %{
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      status: user.status
    }
  end

  defp extract_crypto_attrs(params) do
    %{}
    |> maybe_decode_binary(params, "encrypted_key_bundle", :encrypted_key_bundle)
    |> maybe_decode_binary(params, "key_bundle_salt", :key_bundle_salt)
    |> maybe_decode_binary(params, "key_bundle_nonce", :key_bundle_nonce)
    |> maybe_decode_binary(params, "public_identity_key", :public_identity_key)
    |> maybe_decode_binary(params, "public_key_exchange", :public_key_exchange)
    |> maybe_put(params, "recovery_key_hash", :recovery_key_hash)
    |> maybe_decode_binary(params, "encrypted_recovery_bundle", :encrypted_recovery_bundle)
  end

  defp maybe_decode_binary(acc, params, key, field) do
    case params[key] do
      nil -> acc
      value -> Map.put(acc, field, Base.decode64!(value))
    end
  end

  defp maybe_put(acc, params, key, field) do
    case params[key] do
      nil -> acc
      value -> Map.put(acc, field, value)
    end
  end

  defp format_errors(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {msg, opts} ->
      Regex.replace(~r"%{(\w+)}", msg, fn _, key ->
        opts |> Keyword.get(String.to_existing_atom(key), key) |> to_string()
      end)
    end)
  end
end
