defmodule VesperWeb.UnreadController do
  use VesperWeb, :controller
  alias Vesper.Chat
  alias Vesper.Servers

  def index(conn, _params) do
    user = conn.assigns.current_user

    channel_ids = Servers.list_user_channel_ids(user.id)
    conversation_ids = Chat.list_user_conversation_ids(user.id)

    json(conn, Chat.get_combined_unread_counts(user.id, channel_ids, conversation_ids))
  end
end
