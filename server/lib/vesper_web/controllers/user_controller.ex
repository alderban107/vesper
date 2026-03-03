defmodule VesperWeb.UserController do
  use VesperWeb, :controller
  alias Vesper.Accounts

  def search(conn, %{"username" => username}) when byte_size(username) >= 2 do
    case Accounts.get_user_by_username(username) do
      nil ->
        json(conn, %{users: []})

      user ->
        json(conn, %{
          users: [
            %{
              id: user.id,
              username: user.username,
              display_name: user.display_name,
              avatar_url: user.avatar_url,
              status: user.status
            }
          ]
        })
    end
  end

  def search(conn, _params) do
    json(conn, %{users: []})
  end
end
