defmodule VesperWeb.PendingHistoryRequestController do
  use VesperWeb, :controller
  alias Vesper.Encryption
  alias VesperWeb.ControllerHelpers

  @doc "GET /api/v1/pending-history-requests/:channel_id — fetch pending history requests for the current MLS scope"
  def index(conn, %{"channel_id" => scope_id}) do
    user = conn.assigns.current_user

    case authorized_scope(user.id, scope_id) do
      {:ok, authorization} ->
        render_requests(conn, Encryption.get_pending_history_requests(authorization.group_id))

      {:error, :invalid_scope} ->
        conn |> put_status(:bad_request) |> json(%{error: "invalid scope"})

      {:error, :forbidden} ->
        conn |> put_status(:forbidden) |> json(%{error: "not a member"})

      {:error, :not_found} ->
        conn |> put_status(:not_found) |> json(%{error: "scope not found"})
    end
  end

  @doc "DELETE /api/v1/pending-history-requests/:id — acknowledge a processed history request"
  def delete(conn, %{"id" => id}) do
    user = conn.assigns.current_user
    request = Encryption.get_pending_history_request(id)

    cond do
      is_nil(request) ->
        json(conn, %{ok: true})

      request.requester_id != user.id ->
        conn |> put_status(:forbidden) |> json(%{error: "forbidden"})

      request.requester_client_id != conn.assigns.current_device.client_id ->
        conn |> put_status(:forbidden) |> json(%{error: "forbidden"})

      match?({:error, _}, authorized_scope(user.id, request.group_id)) ->
        conn |> put_status(:forbidden) |> json(%{error: "forbidden"})

      true ->
        Encryption.delete_pending_history_request(id)
        json(conn, %{ok: true})
    end
  end

  defp render_requests(conn, requests) do
    json(conn, %{
      requests:
        Enum.map(requests, fn request ->
          %{
            id: request.id,
            requester_id: request.requester_id,
            requester_username: request.requester_username,
            requester_client_id: request.requester_client_id,
            membership_generation: request.membership_generation,
            authorization_generation: request.authorization_generation,
            authorized_after_room_seq: request.authorized_after_room_seq,
            inserted_at: request.inserted_at
          }
        end)
    })
  end

  defp authorized_scope(user_id, scope_id) do
    ControllerHelpers.authorize_history_scope(user_id, scope_id)
  end
end
