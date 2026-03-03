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
        {:ok, assign(socket, :user_id, claims["sub"])}

      {:error, _} ->
        :error
    end
  end

  def connect(_params, _socket, _connect_info), do: :error

  @impl true
  def id(socket), do: "user_socket:#{socket.assigns.user_id}"
end
