defmodule VesperWeb.PendingHistoryBundleController do
  use VesperWeb, :controller
  alias Vesper.Chat
  alias Vesper.Encryption
  alias Vesper.Servers

  @doc "GET /api/v1/pending-history-bundles/:channel_id — fetch pending same-user history bundles for the current MLS scope"
  def index(conn, %{"channel_id" => scope_id}) do
    user = conn.assigns.current_user
    current_device = conn.assigns.current_device

    case authorized_scope(user.id, scope_id) do
      {:ok, authorized_group_id} ->
        render_bundles(
          conn,
          Encryption.get_pending_history_bundles(
            user.id,
            authorized_group_id,
            current_device.client_id
          )
        )

      {:error, :invalid_scope} ->
        conn |> put_status(:bad_request) |> json(%{error: "invalid scope"})

      {:error, :forbidden} ->
        conn |> put_status(:forbidden) |> json(%{error: "not a member"})

      {:error, :not_found} ->
        conn |> put_status(:not_found) |> json(%{error: "scope not found"})
    end
  end

  @doc "DELETE /api/v1/pending-history-bundles/:id — acknowledge a processed history bundle"
  def delete(conn, %{"id" => id}) do
    user = conn.assigns.current_user
    bundle = Encryption.get_pending_history_bundle(id)

    cond do
      is_nil(bundle) ->
        json(conn, %{ok: true})

      bundle.recipient_id != user.id ->
        conn |> put_status(:forbidden) |> json(%{error: "forbidden"})

      bundle.recipient_client_id != conn.assigns.current_device.client_id ->
        conn |> put_status(:forbidden) |> json(%{error: "forbidden"})

      true ->
        Encryption.delete_pending_history_bundle(id)
        json(conn, %{ok: true})
    end
  end

  defp render_bundles(conn, bundles) do
    json(conn, %{
      bundles:
        Enum.map(bundles, fn bundle ->
          %{
            id: bundle.id,
            ciphertext: bundle.ciphertext,
            mls_epoch: bundle.mls_epoch,
            recipient_id: bundle.recipient_id,
            recipient_client_id: bundle.recipient_client_id,
            sender_id: bundle.sender_id,
            inserted_at: bundle.inserted_at
          }
        end)
    })
  end

  defp authorized_scope(user_id, scope_id) do
    with {:ok, uuid} <- Ecto.UUID.cast(scope_id) do
      case authorize_channel_scope(user_id, uuid) do
        {:error, :not_found} -> authorize_conversation_scope(user_id, uuid)
        result -> result
      end
    else
      :error -> {:error, :invalid_scope}
    end
  end

  defp authorize_channel_scope(user_id, channel_id) do
    case Servers.get_channel(channel_id) do
      nil ->
        {:error, :not_found}

      channel ->
        if Servers.user_can_view_channel?(user_id, channel) do
          {:ok, channel_id}
        else
          {:error, :forbidden}
        end
    end
  end

  defp authorize_conversation_scope(user_id, conversation_id) do
    case Chat.get_conversation(conversation_id) do
      nil ->
        {:error, :not_found}

      _conversation ->
        if Chat.user_is_participant?(user_id, conversation_id) do
          {:ok, conversation_id}
        else
          {:error, :forbidden}
        end
    end
  end
end
