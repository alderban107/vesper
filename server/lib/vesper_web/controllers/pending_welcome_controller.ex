defmodule VesperWeb.PendingWelcomeController do
  use VesperWeb, :controller
  alias Vesper.Encryption
  alias Vesper.Servers

  @doc "GET /api/v1/pending-welcomes/:channel_id — fetch pending welcomes for current user in a channel"
  def index(conn, %{"channel_id" => channel_id}) do
    user = conn.assigns.current_user
    channel = Servers.get_channel(channel_id)

    cond do
      is_nil(channel) ->
        conn |> put_status(:not_found) |> json(%{error: "channel not found"})

      not Servers.user_is_member?(user.id, channel.server_id) ->
        conn |> put_status(:forbidden) |> json(%{error: "not a member"})

      true ->
        welcomes = Encryption.get_pending_welcomes(user.id, channel_id)

        json(conn, %{
          welcomes:
            Enum.map(welcomes, fn w ->
              %{
                id: w.id,
                welcome_data: Base.encode64(w.welcome_data),
                sender_id: w.sender_id,
                inserted_at: w.inserted_at
              }
            end)
        })
    end
  end

  @doc "DELETE /api/v1/pending-welcomes/:id — acknowledge a processed welcome"
  def delete(conn, %{"id" => id}) do
    user = conn.assigns.current_user
    welcome = Encryption.get_pending_welcome(id)

    cond do
      is_nil(welcome) ->
        conn |> put_status(:not_found) |> json(%{error: "not found"})

      welcome.recipient_id != user.id ->
        conn |> put_status(:forbidden) |> json(%{error: "forbidden"})

      true ->
        Encryption.delete_pending_welcome(id)
        json(conn, %{ok: true})
    end
  end
end
