defmodule VesperWeb.ServerPresenceChannel do
  use Phoenix.Channel

  alias Vesper.Servers
  alias VesperWeb.Presence

  @impl true
  def join("presence:server:" <> server_id, _payload, socket) do
    if Servers.user_is_member?(socket.assigns.user_id, server_id) do
      send(self(), :after_join)
      {:ok, assign(socket, :server_id, server_id)}
    else
      {:error, %{reason: "not a member"}}
    end
  end

  @impl true
  def handle_info(:after_join, socket) do
    Presence.track(socket, socket.assigns.user_id, %{
      status: "online",
      joined_at: System.system_time(:second)
    })

    push(socket, "presence_state", Presence.list(socket))
    {:noreply, socket}
  end

  @impl true
  def handle_in(_event, _payload, socket),
    do: {:reply, {:error, %{reason: "unrecognized event"}}, socket}
end
