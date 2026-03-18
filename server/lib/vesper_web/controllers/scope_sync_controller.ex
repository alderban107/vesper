defmodule VesperWeb.ScopeSyncController do
  use VesperWeb, :controller

  alias Vesper.Chat
  alias Vesper.Runtime
  alias Vesper.Servers
  alias Vesper.Sync
  alias Vesper.SyncCursor

  @default_limit 50
  @max_limit 100

  def create(conn, params) do
    user = conn.assigns.current_user
    limit = parse_limit(params["limit"])
    cursor = parse_since(params["since"])
    since = cursor && cursor.synced_at
    scopes = normalize_scopes(params["scopes"])

    token =
      SyncCursor.encode(%{
        synced_at: DateTime.utc_now(),
        user_sync_event_id: Sync.latest_event_id_for_user(user.id)
      })

    json(conn, %{
      token: token,
      scopes: sync_scopes(user.id, scopes, limit, since)
    })
  end

  defp parse_limit(limit) when is_integer(limit) and limit > 0, do: min(limit, @max_limit)

  defp parse_limit(limit) when is_binary(limit) do
    case Integer.parse(limit) do
      {value, _} when value > 0 -> min(value, @max_limit)
      _ -> @default_limit
    end
  end

  defp parse_limit(_), do: @default_limit

  defp normalize_scopes(scopes) when is_list(scopes) do
    Enum.flat_map(scopes, fn
      %{"kind" => kind, "id" => id} = scope when is_binary(kind) and is_binary(id) ->
        [
          %{
            kind: kind,
            id: id,
            after: parse_after(scope["after"]),
            after_seq: parse_after_seq(scope["after_seq"])
          }
        ]

      _ ->
        []
    end)
  end

  defp normalize_scopes(_), do: []

  defp parse_after(nil), do: nil

  defp parse_after(value) when is_binary(value) and value != "", do: value

  defp parse_after(_), do: nil

  defp parse_after_seq(value) when is_integer(value) and value >= 0, do: value

  defp parse_after_seq(value) when is_binary(value) and value != "" do
    case Integer.parse(value) do
      {parsed, _rest} when parsed >= 0 -> parsed
      _ -> nil
    end
  end

  defp parse_after_seq(_), do: nil

  defp parse_since(value), do: SyncCursor.decode(value)

  defp sync_scopes(user_id, scopes, limit, since) do
    channel_scopes = Enum.filter(scopes, &(&1.kind == "channel"))
    channel_ids = channel_scopes |> Enum.map(& &1.id) |> Enum.uniq()

    channels_by_id =
      user_id
      |> Servers.list_viewable_channels(channel_ids)
      |> Map.new(&{&1.id, &1})

    channel_rooms_by_id =
      channels_by_id
      |> Map.keys()
      |> Runtime.list_rooms_for_channels()

    dm_scopes = Enum.filter(scopes, &(&1.kind == "dm"))
    dm_ids = dm_scopes |> Enum.map(& &1.id) |> Enum.uniq()
    accessible_dm_ids = Chat.list_accessible_conversation_ids(user_id, dm_ids)

    dm_rooms_by_id =
      accessible_dm_ids
      |> MapSet.to_list()
      |> Runtime.list_rooms_for_conversations()

    Enum.flat_map(scopes, fn scope ->
      sync_scope(
        scope,
        limit,
        since,
        channels_by_id,
        channel_rooms_by_id,
        accessible_dm_ids,
        dm_rooms_by_id
      )
    end)
  end

  defp sync_scope(
         %{kind: "channel", id: channel_id, after: after_cursor, after_seq: after_seq},
         limit,
         since,
         channels_by_id,
         channel_rooms_by_id,
         _accessible_dm_ids,
         _dm_rooms_by_id
       ) do
    case Map.get(channels_by_id, channel_id) do
      nil ->
        []

      _channel ->
        room = Map.get(channel_rooms_by_id, channel_id)

        {messages, events, has_more} =
          cond do
            is_integer(after_seq) ->
              sync_scope_after_seq(
                room,
                after_seq,
                limit,
                fn query_limit ->
                  chat_opts =
                    if room do
                      [limit: query_limit, room_id: room.id]
                    else
                      [limit: query_limit]
                    end

                  Chat.list_channel_messages_after_seq(channel_id, after_seq, chat_opts)
                end,
                fn query_limit ->
                  if room do
                    Runtime.list_scope_events_after_seq(room, after_seq, limit: query_limit)
                  else
                    []
                  end
                end
              )

            true ->
              messages =
                Chat.list_channel_messages(channel_id, limit: limit, after: after_cursor)

              events =
                if since && room do
                  Runtime.list_scope_events(room, since, limit: max(limit * 4, 100))
                else
                  []
                end

              {messages, events, length(messages) == limit}
          end

        [
          %{
            scope_id: channel_id,
            kind: "channel",
            has_more: has_more,
            messages: Enum.map(messages, &message_json/1),
            events: Enum.map(events, &sync_event_json/1)
          }
        ]
    end
  end

  defp sync_scope(
         %{kind: "dm", id: conversation_id, after: after_cursor, after_seq: after_seq},
         limit,
         since,
         _channels_by_id,
         _channel_rooms_by_id,
         accessible_dm_ids,
         dm_rooms_by_id
       ) do
    if MapSet.member?(accessible_dm_ids, conversation_id) do
      room = Map.get(dm_rooms_by_id, conversation_id)

      {messages, events, has_more} =
        cond do
          is_integer(after_seq) ->
            sync_scope_after_seq(
              room,
              after_seq,
              limit,
              fn query_limit ->
                chat_opts =
                  if room do
                    [limit: query_limit, room_id: room.id]
                  else
                    [limit: query_limit]
                  end

                Chat.list_conversation_messages_after_seq(
                  conversation_id,
                  after_seq,
                  chat_opts
                )
              end,
              fn query_limit ->
                if room do
                  Runtime.list_scope_events_after_seq(room, after_seq, limit: query_limit)
                else
                  []
                end
              end
            )

          true ->
            messages =
              Chat.list_conversation_messages(conversation_id, limit: limit, after: after_cursor)

            events =
              if since && room do
                Runtime.list_scope_events(room, since, limit: max(limit * 4, 100))
              else
                []
              end

            {messages, events, length(messages) == limit}
        end

      [
        %{
          scope_id: conversation_id,
          kind: "dm",
          has_more: has_more,
          messages: Enum.map(messages, &message_json/1),
          events: Enum.map(events, &sync_event_json/1)
        }
      ]
    else
      []
    end
  end

  defp sync_scope(
         _scope,
         _limit,
         _since,
         _channels_by_id,
         _channel_rooms_by_id,
         _dm_ids,
         _dm_rooms
       ),
       do: []

  defp sync_scope_after_seq(room, after_seq, limit, list_messages, list_events) do
    event_limit = max(limit * 4, 100)
    room_current_seq = if(room, do: room.current_seq || 0, else: 0)
    room_last_message_seq = if(room, do: room.last_message_seq || 0, else: 0)
    room_last_mutation_seq = if(room, do: room.last_mutation_seq || 0, else: 0)

    cond do
      after_seq >= room_current_seq ->
        {[], [], false}

      true ->
        messages =
          if after_seq < room_last_message_seq do
            list_messages.(limit)
          else
            []
          end

        events =
          if after_seq < room_last_mutation_seq do
            list_events.(event_limit)
          else
            []
          end

        has_more =
          (room_last_message_seq > after_seq and length(messages) == limit) or
            (room_last_mutation_seq > after_seq and length(events) == event_limit)

        {messages, events, has_more}
    end
  end

  defp message_json(message) do
    base = %{
      id: message.id,
      room_seq: message.room_seq,
      channel_id: message.channel_id,
      conversation_id: message.conversation_id,
      sender_id: message.sender_id,
      sender: sender_json(message.sender),
      expires_at: message.expires_at,
      parent_message_id: message.parent_message_id,
      inserted_at: message.inserted_at,
      attachments: attachments_json(message),
      reactions: reactions_json(message)
    }

    if message.ciphertext do
      Map.merge(base, %{
        ciphertext: Base.encode64(message.ciphertext),
        mls_epoch: message.mls_epoch
      })
    else
      Map.put(base, :content, message.content)
    end
  end

  defp attachments_json(%{attachments: attachments}) when is_list(attachments) do
    Enum.map(attachments, fn attachment ->
      %{
        id: attachment.id,
        filename: attachment.filename,
        content_type: attachment.content_type,
        size_bytes: attachment.size_bytes,
        encrypted: attachment.encrypted
      }
    end)
  end

  defp attachments_json(_), do: []

  defp reactions_json(%{reactions: reactions}) when is_list(reactions) do
    Enum.map(reactions, fn reaction ->
      %{
        id: reaction.id,
        emoji: reaction.emoji,
        ciphertext: reaction.ciphertext,
        mls_epoch: reaction.mls_epoch,
        sender_id: reaction.sender_id,
        inserted_at: reaction.inserted_at
      }
    end)
  end

  defp reactions_json(_), do: []

  defp sender_json(nil), do: nil

  defp sender_json(sender) do
    %{
      id: sender.id,
      username: sender.username,
      display_name: sender.display_name,
      avatar_url: sender.avatar_url
    }
  end

  defp sync_event_json(event) do
    %{
      id: event.id,
      room_seq: event.room_seq,
      event_type: event.event_type,
      message_id: event_message_id(event),
      inserted_at: event.inserted_at,
      payload: event.content
    }
  end

  defp event_message_id(event) do
    event.message_id ||
      Map.get(event.content || %{}, "message_id") ||
      Map.get(event.content || %{}, :message_id)
  end
end
