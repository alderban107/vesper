defmodule VesperWeb.Plugs.Auth do
  import Plug.Conn
  alias Vesper.Accounts
  alias Vesper.Accounts.Token

  def init(opts), do: opts

  def call(conn, _opts) do
    with ["Bearer " <> token] <- get_req_header(conn, "authorization"),
         {:ok, claims} <- Token.verify_access_token(token),
         user when not is_nil(user) <- Accounts.get_user(claims["sub"]),
         device_id when is_binary(device_id) <- claims["device_id"],
         device when not is_nil(device) <- Accounts.get_user_device(user.id, device_id),
         false <- device_revoked?(device) do
      conn
      |> assign(:current_user, user)
      |> assign(:current_device, device)
      |> assign(:current_device_trusted?, device.trust_state == "trusted")
    else
      _ ->
        conn
        |> put_status(:unauthorized)
        |> Phoenix.Controller.json(%{error: "unauthorized"})
        |> halt()
    end
  end

  defp device_revoked?(device) do
    device.trust_state == "revoked" or not is_nil(device.revoked_at)
  end
end
