defmodule VesperWeb.SyncController do
  use VesperWeb, :controller

  alias Vesper.Chat
  alias Vesper.Servers
  alias Vesper.Sync
  alias Vesper.SyncCursor
  alias VesperWeb.ScopeSummary

  def index(conn, params) do
    user = conn.assigns.current_user
    cursor = parse_since(params["since"])
    since = cursor && cursor.synced_at
    user_sync_event_id = cursor && cursor.user_sync_event_id
    scope_sync_event_id = cursor && cursor[:scope_sync_event_id]
    full_sync = is_nil(since)

    scope_changes =
      cond do
        is_integer(scope_sync_event_id) and is_integer(user_sync_event_id) ->
          # Best path: separate cursors for scope and user events (1 query each)
          Sync.list_scope_changes_with_cursors(
            user.id,
            scope_sync_event_id,
            user_sync_event_id
          )

        is_integer(scope_sync_event_id) ->
          # Scope cursor only (uses scope ID for both)
          Sync.list_scope_changes_since(user.id, scope_sync_event_id)

        is_integer(user_sync_event_id) ->
          # Legacy path: user event ID cursor only
          Sync.list_scope_changes_since(user.id, user_sync_event_id)

        is_nil(since) ->
          %{channel_ids: [], conversation_ids: [], read_changes: []}

        true ->
          %{
            channel_ids: Servers.list_changed_channel_ids_since(user.id, since),
            conversation_ids: Chat.list_changed_conversation_ids_since(user.id, since),
            read_changes:
              Enum.map(
                Chat.list_channels_with_read_changes_since(user.id, since),
                &{:channel, &1}
              ) ++
                Enum.map(
                  Chat.list_conversations_with_read_changes_since(user.id, since),
                  &{:dm, &1}
                )
          }
      end

    servers =
      cond do
        is_nil(since) ->
          Servers.list_user_servers(user)

        is_integer(user_sync_event_id) ->
          Servers.list_user_servers_by_ids(user, scope_changes.server_ids)

        true ->
          Servers.list_user_servers_since(user, since)
      end

    conversations =
      cond do
        is_nil(since) ->
          Chat.list_conversations(user.id)

        is_integer(user_sync_event_id) ->
          Chat.list_conversations_by_ids(user.id, scope_changes.conversation_ids)

        true ->
          Chat.list_conversations_since(user.id, since)
      end

    changed_conversation_ids = scope_changes.conversation_ids

    conversation_messages_by_id =
      Map.new(conversations, fn %{conversation: conversation, last_message: last_message} ->
        {conversation.id, last_message}
      end)

    missing_reset_ids =
      Enum.reject(changed_conversation_ids, &Map.has_key?(conversation_messages_by_id, &1))

    conversation_reset_messages =
      conversation_messages_by_id
      |> Map.take(changed_conversation_ids)
      |> Map.merge(Chat.get_latest_conversation_messages(missing_reset_ids))

    conversation_resets =
      Enum.map(changed_conversation_ids, fn conversation_id ->
        %{
          conversation_id: conversation_id,
          last_message:
            case Map.get(conversation_reset_messages, conversation_id) do
              nil -> nil
              message -> message_json(message)
            end
        }
      end)

    {channel_activity, unread_counts} =
      case since do
        nil ->
          channel_ids = Servers.list_user_channel_ids(user.id)

          conversation_ids =
            Enum.map(conversations, fn %{conversation: c} -> c.id end)

          unread_counts =
            Chat.get_combined_unread_counts(user.id, channel_ids, conversation_ids)

          {Servers.list_channel_activity_snapshots(user.id, channel_ids), unread_counts}

        _value ->
          changed_channel_ids = scope_changes.channel_ids
          changed = Servers.list_channel_activity_snapshots(user.id, changed_channel_ids)

          unread_channel_ids =
            changed_channel_ids
            |> Kernel.++(
              scope_changes.read_changes
              |> Enum.flat_map(fn
                {:channel, channel_id} -> [channel_id]
                _ -> []
              end)
            )
            |> Enum.uniq()

          unread_conversation_ids =
            changed_conversation_ids
            |> Kernel.++(
              scope_changes.read_changes
              |> Enum.flat_map(fn
                {:dm, conversation_id} -> [conversation_id]
                _ -> []
              end)
            )
            |> Enum.uniq()

          unread_counts = %{
            channels: Chat.get_channel_unread_counts_snapshot(user.id, unread_channel_ids),
            conversations: Chat.get_dm_unread_counts_snapshot(user.id, unread_conversation_ids)
          }

          {changed, unread_counts}
      end

    token =
      SyncCursor.encode(%{
        synced_at: DateTime.utc_now(),
        user_sync_event_id: Sync.latest_event_id_for_user(user.id),
        scope_sync_event_id: Sync.latest_scope_event_id()
      })

    json(conn, %{
      token: token,
      full: full_sync,
      servers: Enum.map(servers, &server_json/1),
      conversations: Enum.map(conversations, &conversation_with_last_message_json/1),
      conversation_resets: conversation_resets,
      channel_activity: Enum.map(channel_activity, &channel_activity_json/1),
      unread_counts: unread_counts
    })
  end

  defp parse_since(value), do: SyncCursor.decode(value)

  defp server_json(server) do
    %{
      id: server.id,
      name: server.name,
      icon_url: server.icon_url,
      owner_id: server.owner_id,
      channels:
        case server.channels do
          %Ecto.Association.NotLoaded{} -> []
          channels -> Enum.map(channels, &channel_json/1)
        end,
      emojis:
        case server.emojis do
          %Ecto.Association.NotLoaded{} -> []
          emojis -> Enum.map(emojis, &emoji_json/1)
        end,
      inserted_at: server.inserted_at,
      updated_at: server.updated_at
    }
  end

  defp channel_json(channel) do
    %{
      id: channel.id,
      server_id: channel.server_id,
      name: channel.name,
      type: channel.type,
      category_id: channel.category_id,
      topic: channel.topic,
      position: channel.position,
      disappearing_ttl: channel.disappearing_ttl,
      updated_at: channel.updated_at,
      inserted_at: channel.inserted_at
    }
  end

  defp emoji_json(emoji) do
    %{
      id: emoji.id,
      name: emoji.name,
      url: emoji.url,
      animated: emoji.animated,
      server_id: emoji.server_id,
      creator: emoji_creator_json(emoji)
    }
  end

  defp emoji_creator_json(%{
         creator: %{
           id: id,
           username: username,
           display_name: display_name,
           avatar_url: avatar_url
         }
       }) do
    %{id: id, username: username, display_name: display_name, avatar_url: avatar_url}
  end

  defp emoji_creator_json(_), do: nil

  defp conversation_with_last_message_json(%{
         conversation: conversation,
         last_message: last_message
       }) do
    conversation_json(conversation)
    |> Map.put(:last_message, if(last_message, do: message_json(last_message), else: nil))
  end

  defp conversation_json(conversation) do
    %{
      id: conversation.id,
      type: conversation.type,
      name: conversation.name,
      disappearing_ttl: conversation.disappearing_ttl,
      inserted_at: conversation.inserted_at,
      participants:
        case conversation.participants do
          %Ecto.Association.NotLoaded{} ->
            []

          participants ->
            Enum.map(participants, fn participant ->
              %{
                id: participant.id,
                user_id: participant.user_id,
                joined_at: participant.joined_at,
                user: user_json(participant.user)
              }
            end)
        end
    }
  end

  defp message_json(message) do
    base = %{
      id: message.id,
      conversation_id: message.conversation_id,
      channel_id: message.channel_id,
      client_nonce: message.client_nonce,
      sender_id: message.sender_id,
      sender: sender_json(message.sender),
      inserted_at: message.inserted_at
    }

    if message.ciphertext do
      Map.put(base, :ciphertext, "encrypted")
    else
      Map.put(base, :content, message.content)
    end
  end

  defp channel_activity_json(%{channel_id: channel_id, message: message}) do
    ScopeSummary.channel_activity_json(channel_id, message)
  end

  defp sender_json(nil), do: nil

  defp sender_json(sender) do
    %{
      id: sender.id,
      username: sender.username,
      display_name: sender.display_name,
      avatar_url: sender.avatar_url
    }
  end

  defp user_json(%Ecto.Association.NotLoaded{}), do: nil

  defp user_json(user) do
    %{
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      status: user.status
    }
  end
end
