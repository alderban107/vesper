defmodule VesperWeb.ScopeRecoveryPackageController do
  use VesperWeb, :controller

  alias Vesper.Chat
  alias Vesper.Encryption
  alias Vesper.Servers
  alias Vesper.Servers.Channel

  @max_package_bytes 262_144

  def show(conn, %{"scope_id" => scope_id}) do
    user = conn.assigns.current_user

    with {:ok, authorized_scope_id} <- authorized_scope(user.id, scope_id) do
      case Encryption.get_scope_recovery_package(user.id, authorized_scope_id) do
        nil -> conn |> put_status(:not_found) |> json(%{error: "no recovery package"})
        package -> render_package(conn, package)
      end
    else
      {:error, :invalid_scope} ->
        conn |> put_status(:bad_request) |> json(%{error: "invalid scope"})

      {:error, :forbidden} ->
        conn |> put_status(:forbidden) |> json(%{error: "not a member"})

      {:error, :not_found} ->
        conn |> put_status(:not_found) |> json(%{error: "scope not found"})
    end
  end

  def upsert(conn, %{"scope_id" => scope_id} = params) do
    user = conn.assigns.current_user

    with {:ok, authorized_scope_id} <- authorized_scope(user.id, scope_id),
         {:ok, nonce} <- decode_nonce(params),
         {:ok, attrs} <- package_attrs(params, user.id, authorized_scope_id, nonce),
         {:ok, package} <- Encryption.upsert_scope_recovery_package(attrs) do
      render_package(conn, package)
    else
      {:error, :invalid_scope} ->
        conn |> put_status(:bad_request) |> json(%{error: "invalid scope"})

      {:error, :forbidden} ->
        conn |> put_status(:forbidden) |> json(%{error: "not a member"})

      {:error, :not_found} ->
        conn |> put_status(:not_found) |> json(%{error: "scope not found"})

      {:error, :invalid_package} ->
        conn |> put_status(:bad_request) |> json(%{error: "invalid recovery package"})

      {:error, :package_too_large} ->
        conn |> put_status(413) |> json(%{error: "recovery package too large"})

      {:error, changeset} ->
        conn
        |> put_status(:unprocessable_entity)
        |> json(%{
          errors: Ecto.Changeset.traverse_errors(changeset, fn {message, _} -> message end)
        })
    end
  end

  defp package_attrs(params, owner_id, scope_id, nonce) do
    with ciphertext when is_binary(ciphertext) and byte_size(ciphertext) > 0 <-
           params["ciphertext"],
         {:ok, ciphertext_bytes} when byte_size(ciphertext_bytes) > 0 <-
           Base.decode64(ciphertext),
         generation when is_integer(generation) and generation >= 0 <-
           params["membership_generation"],
         cursor when is_integer(cursor) and cursor >= 0 <- params["last_event_seq"],
         version when is_integer(version) and version == 1 <- params["schema_version"],
         true <- byte_size(ciphertext_bytes) + byte_size(nonce) <= @max_package_bytes do
      {:ok,
       %{
         owner_id: owner_id,
         scope_id: scope_id,
         ciphertext: ciphertext,
         nonce: nonce,
         membership_generation: generation,
         last_event_seq: cursor,
         schema_version: version,
         byte_size: byte_size(ciphertext_bytes) + byte_size(nonce),
         expires_at:
           DateTime.add(DateTime.utc_now(), 7 * 24 * 60 * 60, :second)
           |> DateTime.truncate(:second)
       }}
    else
      false -> {:error, :package_too_large}
      _ -> {:error, :invalid_package}
    end
  end

  defp decode_nonce(%{"nonce" => nonce}) when is_binary(nonce) do
    case Base.decode64(nonce) do
      {:ok, decoded} when byte_size(decoded) == 12 -> {:ok, decoded}
      _ -> {:error, :invalid_package}
    end
  end

  defp decode_nonce(_), do: {:error, :invalid_package}

  defp render_package(conn, package) do
    json(conn, %{
      package: %{
        ciphertext: package.ciphertext,
        nonce: Base.encode64(package.nonce),
        membership_generation: package.membership_generation,
        last_event_seq: package.last_event_seq,
        schema_version: package.schema_version,
        byte_size: package.byte_size,
        expires_at: package.expires_at
      }
    })
  end

  defp authorized_scope(user_id, scope_id) do
    with {:ok, uuid} <- Ecto.UUID.cast(scope_id) do
      case Servers.get_channel(uuid) do
        nil ->
          case Chat.get_conversation(uuid) do
            nil ->
              {:error, :not_found}

            _ ->
              if Chat.user_is_participant?(user_id, uuid),
                do: {:ok, uuid},
                else: {:error, :forbidden}
          end

        channel ->
          authorize_channel(user_id, channel)
      end
    else
      :error -> {:error, :invalid_scope}
    end
  end

  defp authorize_channel(user_id, %Channel{} = channel) do
    if Channel.dm_type?(channel.type) do
      case Chat.get_dm_context_for_channel(channel.id) do
        {_conversation_id, participant_ids} ->
          if user_id in participant_ids, do: {:ok, channel.id}, else: {:error, :forbidden}

        nil ->
          {:error, :not_found}
      end
    else
      if Servers.user_can_view_channel?(user_id, channel),
        do: {:ok, channel.id},
        else: {:error, :forbidden}
    end
  end
end
