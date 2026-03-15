defmodule VesperWeb.VoiceController do
  use VesperWeb, :controller

  def config(conn, _params) do
    json(conn, %{
      ice_servers: Application.get_env(:vesper, :ice_servers, []),
      ice_transport_policy: Application.get_env(:vesper, :ice_transport_policy, "all")
    })
  end
end
