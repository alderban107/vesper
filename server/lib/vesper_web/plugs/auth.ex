defmodule VesperWeb.Plugs.Auth do
  import Plug.Conn
  alias Vesper.Accounts
  alias Vesper.Accounts.Token

  def init(opts), do: opts

  def call(conn, _opts) do
    with ["Bearer " <> token] <- get_req_header(conn, "authorization"),
         {:ok, claims} <- Token.verify_access_token(token),
         user when not is_nil(user) <- Accounts.get_user(claims["sub"]) do
      assign(conn, :current_user, user)
    else
      _ ->
        conn
        |> put_status(:unauthorized)
        |> Phoenix.Controller.json(%{error: "unauthorized"})
        |> halt()
    end
  end
end
