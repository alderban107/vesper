defmodule VesperWeb.PushController do
  use VesperWeb, :controller

  alias Vesper.Notifications

  def vapid_key(conn, _params) do
    case Notifications.vapid_public_key() do
      nil ->
        conn
        |> put_status(404)
        |> json(%{error: "push notifications not configured"})

      key ->
        json(conn, %{vapid_public_key: key})
    end
  end
end
