defmodule VesperWeb.AuthController do
  use VesperWeb, :controller
  alias Vesper.Accounts
  alias Vesper.Accounts.Device
  alias VesperWeb.Endpoint
  import VesperWeb.ControllerHelpers, only: [format_errors: 1]

  def register(conn, %{"username" => _, "password" => _} = params) do
    with :ok <- validate_crypto_params(params),
         {:ok, device_attrs} <- extract_device_attrs(params) do
      case Accounts.register_user(params) do
        {:ok, user} ->
          # If crypto fields are provided, store them
          user =
            if params["encrypted_key_bundle"] do
              {:ok, crypto_attrs} = extract_crypto_attrs(params)
              {:ok, updated} = Accounts.update_key_bundle(user, crypto_attrs)
              updated
            else
              user
            end

          {:ok, device} =
            Accounts.ensure_device(user, device_attrs, "trusted", "registration")

          {:ok, tokens} = Accounts.create_tokens(user, device)

          conn
          |> put_status(:created)
          |> json(session_json(user, tokens, true))

        {:error, changeset} ->
          conn
          |> put_status(:unprocessable_entity)
          |> json(%{errors: format_errors(changeset)})
      end
    else
      {:error, :invalid_base64} ->
        conn
        |> put_status(:bad_request)
        |> json(%{error: "invalid base64 encoding in crypto fields"})

      {:error, :invalid_device_params} ->
        conn
        |> put_status(:bad_request)
        |> json(%{error: "device_id and device_name are required"})
    end
  end

  def register(conn, _params) do
    conn
    |> put_status(:bad_request)
    |> json(%{error: "username and password are required"})
  end

  def login(conn, %{"username" => username, "password" => password} = params) do
    case Accounts.authenticate_user(username, password) do
      {:ok, user} ->
        with {:ok, device_attrs} <- extract_device_attrs(params),
             {:ok, device} <- Accounts.ensure_device(user, device_attrs, "pending"),
             {:ok, tokens} <- Accounts.create_tokens(user, device) do
          if device.trust_state != "trusted" do
            broadcast_device_event(user.id, "device_approval_requested", device)
          end

          json(conn, session_json(user, tokens, device.trust_state == "trusted"))
        else
          {:error, :invalid_device_params} ->
            conn
            |> put_status(:bad_request)
            |> json(%{error: "device_id and device_name are required"})

          {:error, changeset} ->
            conn
            |> put_status(:unprocessable_entity)
            |> json(%{errors: format_errors(changeset)})
        end

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
          expires_in: tokens.expires_in,
          current_device: device_json(tokens.current_device)
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
    json(
      conn,
      auth_state_json(
        conn.assigns.current_user,
        conn.assigns.current_device,
        conn.assigns[:current_device_trusted?] == true
      )
    )
  end

  def update_profile(conn, params) do
    user = conn.assigns.current_user

    attrs =
      params
      |> Map.take(["display_name", "avatar_url", "banner_url", "status"])
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

  def change_password(
        conn,
        %{
          "old_password" => old_password,
          "new_password" => new_password
        } = params
      ) do
    user = conn.assigns.current_user

    with :ok <- validate_crypto_params(params),
         {:ok, bundle_attrs} <-
           (if params["encrypted_key_bundle"] do
              extract_crypto_attrs(params)
            else
              {:ok, %{}}
            end) do
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
    else
      {:error, :invalid_base64} ->
        conn
        |> put_status(:bad_request)
        |> json(%{error: "invalid base64 encoding in crypto fields"})
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

  def recover_reset(
        conn,
        %{
          "recovery_key_hash" => recovery_key_hash,
          "new_password" => new_password
        } = params
      ) do
    with :ok <- validate_crypto_params(params),
         {:ok, bundle_attrs} <- extract_crypto_attrs(params) do
      case Accounts.reset_password_with_recovery(recovery_key_hash, new_password, bundle_attrs) do
        {:ok, user} ->
          with {:ok, device_attrs} <- extract_device_attrs(params),
               {:ok, device} <-
                 Accounts.ensure_device(user, device_attrs, "trusted", "recovery_key"),
               {:ok, tokens} <- Accounts.create_tokens(user, device) do
            broadcast_device_event(user.id, "device_updated", device)
            json(conn, session_json(user, tokens, true))
          else
            {:error, :invalid_device_params} ->
              conn
              |> put_status(:bad_request)
              |> json(%{error: "device_id and device_name are required"})
          end

        {:error, :not_found} ->
          conn
          |> put_status(:not_found)
          |> json(%{error: "invalid recovery key"})

        {:error, changeset} ->
          conn
          |> put_status(:unprocessable_entity)
          |> json(%{errors: format_errors(changeset)})
      end
    else
      {:error, :invalid_base64} ->
        conn
        |> put_status(:bad_request)
        |> json(%{error: "invalid base64 encoding in crypto fields"})
    end
  end

  def devices(conn, _params) do
    user = conn.assigns.current_user

    json(conn, %{
      devices: Enum.map(Accounts.list_devices(user.id), &device_json/1),
      current_device: device_json(conn.assigns.current_device)
    })
  end

  def approve_device(conn, %{"id" => id}) do
    user = conn.assigns.current_user

    if conn.assigns[:current_device_trusted?] != true do
      conn
      |> put_status(:forbidden)
      |> json(%{error: "approve this device from one of your trusted devices"})
    else
      case Accounts.approve_device(user.id, id) do
        {:ok, device} ->
          broadcast_device_event(user.id, "device_updated", device)
          json(conn, %{device: device_json(device)})

        {:error, :not_found} ->
          conn |> put_status(:not_found) |> json(%{error: "device not found"})

        {:error, changeset} ->
          conn |> put_status(:unprocessable_entity) |> json(%{errors: format_errors(changeset)})
      end
    end
  end

  def revoke_device(conn, %{"id" => id}) do
    user = conn.assigns.current_user
    current_device = conn.assigns.current_device

    cond do
      conn.assigns[:current_device_trusted?] != true ->
        conn
        |> put_status(:forbidden)
        |> json(%{error: "remove devices from one of your trusted devices"})

      current_device && current_device.id == id ->
        conn
        |> put_status(:unprocessable_entity)
        |> json(%{error: "sign out on this device instead of removing it from here"})

      true ->
        case Accounts.revoke_device(user.id, id) do
          {:ok, device} ->
            broadcast_device_event(user.id, "device_updated", device)
            Endpoint.broadcast("user_socket:#{user.id}:#{device.id}", "disconnect", %{})
            json(conn, %{device: device_json(device)})

          {:error, :not_found} ->
            conn |> put_status(:not_found) |> json(%{error: "device not found"})

          {:error, changeset} ->
            conn |> put_status(:unprocessable_entity) |> json(%{errors: format_errors(changeset)})
        end
    end
  end

  def approve_current_device_with_recovery(conn, %{"recovery_key_hash" => recovery_key_hash}) do
    user = conn.assigns.current_user
    device = conn.assigns.current_device

    if is_nil(device) do
      conn
      |> put_status(:unprocessable_entity)
      |> json(%{error: "sign in again before approving this device"})
    else
      case Accounts.approve_current_device_with_recovery(user, device.id, recovery_key_hash) do
        {:ok, updated_device} ->
          broadcast_device_event(user.id, "device_updated", updated_device)
          json(conn, auth_state_json(user, updated_device, true))

        {:error, :not_found} ->
          conn |> put_status(:not_found) |> json(%{error: "invalid recovery key"})

        {:error, changeset} ->
          conn |> put_status(:unprocessable_entity) |> json(%{errors: format_errors(changeset)})
      end
    end
  end

  defp user_json(user) do
    %{
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      banner_url: user.banner_url,
      status: user.status
    }
  end

  defp device_json(nil), do: nil

  defp device_json(%Device{} = device) do
    %{
      id: device.id,
      client_id: device.client_id,
      name: device.name,
      platform: device.platform,
      trust_state: device.trust_state,
      approval_method: device.approval_method,
      trusted_at: device.trusted_at,
      revoked_at: device.revoked_at,
      last_seen_at: device.last_seen_at,
      inserted_at: device.inserted_at
    }
  end

  defp session_json(user, tokens, include_crypto_bundle) do
    response = %{
      user: user_json(user),
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      current_device: device_json(tokens.current_device)
    }

    maybe_put_crypto_bundle(response, user, include_crypto_bundle)
  end

  defp auth_state_json(user, device, include_crypto_bundle) do
    %{
      user: user_json(user),
      current_device: device_json(device)
    }
    |> maybe_put_crypto_bundle(user, include_crypto_bundle)
  end

  @binary_crypto_fields [
    {"encrypted_key_bundle", :encrypted_key_bundle},
    {"key_bundle_salt", :key_bundle_salt},
    {"key_bundle_nonce", :key_bundle_nonce},
    {"public_identity_key", :public_identity_key},
    {"public_key_exchange", :public_key_exchange},
    {"encrypted_recovery_bundle", :encrypted_recovery_bundle}
  ]

  defp validate_crypto_params(params) do
    Enum.reduce_while(@binary_crypto_fields, :ok, fn {key, _field}, :ok ->
      case params[key] do
        nil ->
          {:cont, :ok}

        value ->
          case Base.decode64(value) do
            {:ok, _} -> {:cont, :ok}
            :error -> {:halt, {:error, :invalid_base64}}
          end
      end
    end)
  end

  defp extract_device_attrs(params) do
    with device_id when is_binary(device_id) and byte_size(device_id) >= 8 <- params["device_id"],
         device_name when is_binary(device_name) <- params["device_name"],
         trimmed_name <- String.trim(device_name),
         true <- byte_size(trimmed_name) > 0 do
      {:ok,
       %{
         client_id: device_id,
         name: trimmed_name,
         platform: params["device_platform"]
       }}
    else
      _ -> {:error, :invalid_device_params}
    end
  end

  defp extract_crypto_attrs(params) do
    result =
      Enum.reduce_while(@binary_crypto_fields, {:ok, %{}}, fn {key, field}, {:ok, acc} ->
        case params[key] do
          nil ->
            {:cont, {:ok, acc}}

          value ->
            case Base.decode64(value) do
              {:ok, decoded} -> {:cont, {:ok, Map.put(acc, field, decoded)}}
              :error -> {:halt, {:error, :invalid_base64}}
            end
        end
      end)

    case result do
      {:ok, attrs} -> {:ok, maybe_put(attrs, params, "recovery_key_hash", :recovery_key_hash)}
      error -> error
    end
  end

  defp maybe_put(acc, params, key, field) do
    case params[key] do
      nil -> acc
      value -> Map.put(acc, field, value)
    end
  end

  defp maybe_put_crypto_bundle(response, user, true) when not is_nil(user.encrypted_key_bundle) do
    Map.merge(response, %{
      encrypted_key_bundle: Base.encode64(user.encrypted_key_bundle),
      key_bundle_salt: Base.encode64(user.key_bundle_salt),
      key_bundle_nonce: Base.encode64(user.key_bundle_nonce),
      public_identity_key: Base.encode64(user.public_identity_key),
      public_key_exchange: Base.encode64(user.public_key_exchange)
    })
  end

  defp maybe_put_crypto_bundle(response, _user, _include_crypto_bundle), do: response

  defp broadcast_device_event(user_id, event, %Device{} = device) do
    Endpoint.broadcast("user:#{user_id}", event, %{device: device_json(device)})
  end
end
