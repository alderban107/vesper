defmodule VesperWeb.PendingWelcomeController do
  use VesperWeb, :controller
  alias Vesper.Encryption

  @doc "GET /api/v1/pending-welcomes/:channel_id — fetch pending welcomes for current user in a channel"
  def index(conn, %{"channel_id" => channel_id}) do
    user_id = conn.assigns.current_user.id
    welcomes = Encryption.get_pending_welcomes(user_id, channel_id)

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

  @doc "DELETE /api/v1/pending-welcomes/:id — acknowledge a processed welcome"
  def delete(conn, %{"id" => id}) do
    Encryption.delete_pending_welcome(id)
    json(conn, %{ok: true})
  end
end
