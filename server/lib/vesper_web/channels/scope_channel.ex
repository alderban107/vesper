defmodule VesperWeb.ScopeChannel do
  use Phoenix.Channel

  alias Vesper.Chat

  @impl true
  def join("scope:dm:" <> conversation_id, _payload, socket) do
    if Chat.user_is_participant?(socket.assigns.user_id, conversation_id) do
      {:ok, assign(socket, :conversation_id, conversation_id)}
    else
      {:error, %{reason: "not a participant"}}
    end
  end

  @impl true
  def handle_in(_event, _payload, socket),
    do: {:reply, {:error, %{reason: "unrecognized event"}}, socket}
end
