defmodule VesperWeb.UserSocket do
  use Phoenix.Socket

  alias Vesper.Accounts.Token

  channel "chat:channel:*", VesperWeb.ChatChannel
  channel "dm:*", VesperWeb.DmChannel
  channel "voice:channel:*", VesperWeb.VoiceChannel
  channel "voice:dm:*", VesperWeb.VoiceChannel
  channel "user:*", VesperWeb.UserChannel
  channel "presence:server:*", VesperWeb.ServerPresenceChannel

  @impl true
  def connect(%{"token" => token}, socket, _connect_info) do
    case Token.verify_access_token(token) do
      {:ok, claims} ->
        user_id = claims["sub"]
        device_id = claims["device_id"]
        # Pre-load username for typing indicators so channels don't need per-event DB lookups
        user = Vesper.Accounts.get_user(user_id)

        device =
          if is_binary(device_id),
            do: Vesper.Accounts.get_user_device(user_id, device_id),
            else: nil

        cond do
          is_nil(user) or is_nil(device) ->
            :error

          device.trust_state == "revoked" or not is_nil(device.revoked_at) ->
            :error

          true ->
            socket =
              socket
              |> assign(:user_id, user_id)
              |> assign(:device_id, device.id)
              |> assign(:device_trust_state, device.trust_state)
              |> assign(:username, user.username)
              |> assign(:display_name, user.display_name)

            {:ok, socket}
        end

      {:error, _} ->
        :error
    end
  end

  def connect(_params, _socket, _connect_info), do: :error

  @impl true
  def id(socket), do: "user_socket:#{socket.assigns.user_id}:#{socket.assigns.device_id}"
end
