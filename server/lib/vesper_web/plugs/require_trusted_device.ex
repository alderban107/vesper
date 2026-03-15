defmodule VesperWeb.Plugs.RequireTrustedDevice do
  import Plug.Conn

  def init(opts), do: opts

  def call(conn, _opts) do
    if conn.assigns[:current_device_trusted?] do
      conn
    else
      current_device = conn.assigns[:current_device]

      conn
      |> put_status(:forbidden)
      |> Phoenix.Controller.json(%{
        error: "device approval required",
        current_device:
          if(is_nil(current_device),
            do: nil,
            else: %{
              id: current_device.id,
              trust_state: current_device.trust_state
            }
          )
      })
      |> halt()
    end
  end
end
