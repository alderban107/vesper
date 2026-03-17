defmodule VesperWeb.UnreadController do
  use VesperWeb, :controller
  alias Vesper.Chat
  alias Vesper.Servers

  def index(conn, _params) do
    user = conn.assigns.current_user

    channel_ids = Servers.list_user_channel_ids(user.id)
    conversation_ids = Chat.list_user_conversation_ids(user.id)

    channel_counts = Chat.get_channel_unread_counts(user.id, channel_ids)
    dm_counts = Chat.get_dm_unread_counts(user.id, conversation_ids)

    json(conn, %{
      channels: channel_counts,
      conversations: dm_counts
    })
  end
end
