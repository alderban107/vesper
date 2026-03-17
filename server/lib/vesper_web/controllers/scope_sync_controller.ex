defmodule VesperWeb.ScopeSyncController do
  use VesperWeb, :controller

  alias Vesper.Chat
  alias Vesper.Runtime
  alias Vesper.Servers
  alias Vesper.SyncCursor

  @default_limit 50
  @max_limit 100

  def create(conn, params) do
    user = conn.assigns.current_user
    limit = parse_limit(params["limit"])
    cursor = parse_since(params["since"])
    since = cursor && cursor.synced_at
    scopes = normalize_scopes(params["scopes"])

    json(conn, %{
      scopes:
        scopes
        |> Enum.flat_map(&sync_scope(user.id, &1, limit, since))
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

  defp sync_scope(
         user_id,
         %{kind: "channel", id: channel_id, after: after_cursor, after_seq: after_seq},
         limit,
         since
       ) do
    case Servers.get_channel(channel_id) do
      nil ->
        []

      channel ->
        if Servers.user_is_member?(user_id, channel.server_id) and
             Servers.user_can_view_channel?(user_id, channel) do
          room = Runtime.get_room_for_channel(channel_id)
          {messages, events, has_more} =
            cond do
              is_integer(after_seq) ->
                sync_scope_after_seq(
                  room,
                  after_seq,
                  limit,
                  fn query_limit ->
                    Chat.list_channel_messages_after_seq(channel_id, after_seq, limit: query_limit)
                  end,
                  fn query_limit ->
                    Runtime.list_scope_events_after_seq(
                      "channel",
                      channel_id,
                      after_seq,
                      limit: query_limit
                    )
                  end
                )

              true ->
                messages = Chat.list_channel_messages(channel_id, limit: limit, after: after_cursor)

                events =
                  if since do
                    Runtime.list_scope_events("channel", channel_id, since, limit: max(limit * 4, 100))
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
        else
          []
        end
    end
  end

  defp sync_scope(
         user_id,
         %{kind: "dm", id: conversation_id, after: after_cursor, after_seq: after_seq},
         limit,
         since
       ) do
    if Chat.user_is_participant?(user_id, conversation_id) do
      room = Runtime.get_room_for_conversation(conversation_id)

      {messages, events, has_more} =
        cond do
          is_integer(after_seq) ->
            sync_scope_after_seq(
              room,
              after_seq,
              limit,
              fn query_limit ->
                Chat.list_conversation_messages_after_seq(
                  conversation_id,
                  after_seq,
                  limit: query_limit
                )
              end,
              fn query_limit ->
                Runtime.list_scope_events_after_seq(
                  "dm",
                  conversation_id,
                  after_seq,
                  limit: query_limit
                )
              end
            )

          true ->
            messages =
              Chat.list_conversation_messages(conversation_id, limit: limit, after: after_cursor)

            events =
              if since do
                Runtime.list_scope_events("dm", conversation_id, since, limit: max(limit * 4, 100))
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

  defp sync_scope(_user_id, _scope, _limit, _since), do: []

  defp sync_scope_after_seq(room, after_seq, limit, list_messages, list_events) do
    event_limit = max(limit * 4, 100)
    room_current_seq = if(room, do: room.current_seq || 0, else: 0)

    cond do
      after_seq >= room_current_seq ->
        {[], [], false}

      true ->
        message_limit =
          if room && room.last_message_seq && room.last_message_seq > after_seq, do: limit, else: 0

        mutation_limit =
          if room && room.last_mutation_seq && room.last_mutation_seq > after_seq,
            do: event_limit,
            else: 0

        messages =
          if message_limit > 0 do
            list_messages.(message_limit)
          else
            []
          end

        events =
          if mutation_limit > 0 do
            list_events.(mutation_limit)
          else
            []
          end

        has_more =
          (message_limit > 0 and length(messages) == message_limit) or
            (mutation_limit > 0 and length(events) == mutation_limit)

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
