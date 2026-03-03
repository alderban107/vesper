defmodule VesperWeb.UnreadController do
  use VesperWeb, :controller
  alias Vesper.Chat
  alias Vesper.Servers

  def index(conn, _params) do
    user = conn.assigns.current_user

    # Get all server channel IDs the user is a member of
    channel_ids =
      Servers.list_user_servers(user)
      |> Enum.flat_map(fn server -> Enum.map(server.channels, & &1.id) end)

    # Get all DM conversation IDs the user participates in
    conversation_ids =
      Chat.list_conversations(user.id)
      |> Enum.map(fn %{conversation: conv} -> conv.id end)

    channel_counts = Chat.get_channel_unread_counts(user.id, channel_ids)
    dm_counts = Chat.get_dm_unread_counts(user.id, conversation_ids)

    json(conn, %{
      channels: channel_counts,
      conversations: dm_counts
    })
  end
end
