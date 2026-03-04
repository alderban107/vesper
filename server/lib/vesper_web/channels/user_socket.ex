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
        # Pre-load username for typing indicators so channels don't need per-event DB lookups
        user = Vesper.Accounts.get_user(user_id)

        socket =
          socket
          |> assign(:user_id, user_id)
          |> assign(:username, user && user.username)
          |> assign(:display_name, user && user.display_name)

        {:ok, socket}

      {:error, _} ->
        :error
    end
  end

  def connect(_params, _socket, _connect_info), do: :error

  @impl true
  def id(socket), do: "user_socket:#{socket.assigns.user_id}"
end
