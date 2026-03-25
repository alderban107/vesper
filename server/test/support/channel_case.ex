defmodule Vesper.ChannelCase do
  @moduledoc """
  Base case for channel tests requiring database access.
  Sets up the Ecto sandbox and provides common channel helpers.
  """

  use ExUnit.CaseTemplate

  using do
    quote do
      import Phoenix.ChannelTest
      import Vesper.Factory

      alias Vesper.Accounts
      alias Vesper.Accounts.Token
      alias Vesper.Repo
      alias VesperWeb.UserSocket

      @endpoint VesperWeb.Endpoint

      def connect_user_socket(user, client_id \\ nil) do
        client_id = client_id || "client-#{System.unique_integer([:positive])}"
        device_name = "#{user.username}-#{client_id}"

        {:ok, device} =
          Accounts.ensure_device(user, %{client_id: client_id, name: device_name}, "trusted")

        {:ok, token, _claims} = Token.generate_access_token(user, device)
        {:ok, socket} = connect(UserSocket, %{"token" => token})

        socket
      end
    end
  end

  setup tags do
    pid = Ecto.Adapters.SQL.Sandbox.start_owner!(Vesper.Repo, shared: not tags[:async])
    on_exit(fn -> Ecto.Adapters.SQL.Sandbox.stop_owner(pid) end)
    :ok
  end
end
