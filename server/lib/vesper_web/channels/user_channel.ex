defmodule VesperWeb.UserChannel do
  use Phoenix.Channel

  alias VesperWeb.Presence

  @heartbeat_timeout_ms 300_000  # 5 minutes

  @impl true
  def join("user:" <> user_id, _payload, socket) do
    # Only allow users to join their own channel
    if socket.assigns.user_id == user_id do
      send(self(), :after_join)
      {:ok, assign(socket, :heartbeat_ref, nil)}
    else
      {:error, %{reason: "unauthorized"}}
    end
  end

  @impl true
  def handle_info(:after_join, socket) do
    Presence.track(socket, socket.assigns.user_id, %{
      status: "online",
      joined_at: System.system_time(:second)
    })

    push(socket, "presence_state", Presence.list(socket))

    # Start heartbeat timer
    ref = Process.send_after(self(), :heartbeat_timeout, @heartbeat_timeout_ms)
    {:noreply, assign(socket, :heartbeat_ref, ref)}
  end

  def handle_info(:heartbeat_timeout, socket) do
    # No heartbeat received — mark as idle
    Presence.update(socket, socket.assigns.user_id, fn meta ->
      Map.put(meta, :status, "idle")
    end)

    {:noreply, socket}
  end

  @impl true
  def handle_in("heartbeat", _payload, socket) do
    # Cancel old timer, start new one
    if socket.assigns.heartbeat_ref do
      Process.cancel_timer(socket.assigns.heartbeat_ref)
    end

    # Restore online status if was idle
    Presence.update(socket, socket.assigns.user_id, fn meta ->
      if meta.status == "idle" do
        Map.put(meta, :status, "online")
      else
        meta
      end
    end)

    ref = Process.send_after(self(), :heartbeat_timeout, @heartbeat_timeout_ms)
    {:noreply, assign(socket, :heartbeat_ref, ref)}
  end

  def handle_in("set_status", %{"status" => status}, socket)
      when status in ~w(online idle dnd) do
    Presence.update(socket, socket.assigns.user_id, fn meta ->
      Map.put(meta, :status, status)
    end)

    {:reply, :ok, socket}
  end

  def handle_in("set_status", _payload, socket) do
    {:reply, {:error, %{reason: "invalid status"}}, socket}
  end
end
