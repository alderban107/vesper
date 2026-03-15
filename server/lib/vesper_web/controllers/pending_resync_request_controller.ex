defmodule VesperWeb.PendingResyncRequestController do
  use VesperWeb, :controller
  alias Vesper.Encryption
  alias Vesper.Chat
  alias Vesper.Servers

  @doc "GET /api/v1/pending-resync-requests/:channel_id — fetch pending resync requests for the current MLS scope"
  def index(conn, %{"channel_id" => scope_id}) do
    user = conn.assigns.current_user

    case authorized_scope(user.id, scope_id) do
      {:ok, authorized_group_id} ->
        render_requests(conn, Encryption.get_pending_resync_requests(authorized_group_id))

      {:error, :invalid_scope} ->
        conn |> put_status(:bad_request) |> json(%{error: "invalid scope"})

      {:error, :forbidden} ->
        conn |> put_status(:forbidden) |> json(%{error: "not a member"})

      {:error, :not_found} ->
        conn |> put_status(:not_found) |> json(%{error: "scope not found"})
    end
  end

  @doc "DELETE /api/v1/pending-resync-requests/:id — acknowledge a processed resync request"
  def delete(conn, %{"id" => id}) do
    user = conn.assigns.current_user
    request = Encryption.get_pending_resync_request(id)

    cond do
      is_nil(request) ->
        json(conn, %{ok: true})

      match?({:error, _}, authorized_scope(user.id, request.group_id)) ->
        conn |> put_status(:forbidden) |> json(%{error: "forbidden"})

      true ->
        Encryption.delete_pending_resync_request(id)
        json(conn, %{ok: true})
    end
  end

  defp render_requests(conn, requests) do
    json(conn, %{
      requests:
        Enum.map(requests, fn request ->
          %{
            id: request.id,
            request_id: request.request_id,
            requester_id: request.requester_id,
            requester_username: request.requester_username,
            last_known_epoch: request.last_known_epoch,
            reason: request.reason,
            inserted_at: request.inserted_at
          }
        end)
    })
  end

  defp authorized_scope(user_id, "voice:channel:" <> channel_id) do
    case authorize_channel_scope(user_id, channel_id) do
      {:ok, _channel_id} -> {:ok, "voice:channel:#{channel_id}"}
      error -> error
    end
  end

  defp authorized_scope(user_id, "voice:dm:" <> conversation_id) do
    case authorize_conversation_scope(user_id, conversation_id) do
      {:ok, _conversation_id} -> {:ok, "voice:dm:#{conversation_id}"}
      error -> error
    end
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
