defmodule Vesper.Runtime do
  alias Vesper.Chat.{DmConversation, Message}
  alias Vesper.Repo
  alias Vesper.Runtime.{Room, RoomEvent, RoomRelation}
  alias Vesper.Servers.Channel

  def get_room(id), do: Repo.get(Room, id)

  def get_room_for_channel(channel_id) do
    Repo.get_by(Room, channel_id: channel_id)
  end

  def get_room_for_conversation(conversation_id) do
    Repo.get_by(Room, conversation_id: conversation_id)
  end

  def ensure_room_for_channel(%Channel{} = channel) do
    case get_room_for_channel(channel.id) do
      %Room{} = room ->
        {:ok, room}

      nil ->
        %Room{}
        |> Room.changeset(%{
          kind: :channel,
          server_id: channel.server_id,
          channel_id: channel.id
        })
        |> Repo.insert()
    end
  end

  def ensure_room_for_conversation(%DmConversation{} = conversation) do
    case get_room_for_conversation(conversation.id) do
      %Room{} = room ->
        {:ok, room}

      nil ->
        %Room{}
        |> Room.changeset(%{
          kind: :dm,
          conversation_id: conversation.id
        })
        |> Repo.insert()
    end
  end

  def project_message(%Message{} = message) do
    with {:ok, room} <- room_for_message(message),
         {:ok, event} <- ensure_message_event(room, message) do
      maybe_create_thread_relation(event, message)
    end
  end

  defp room_for_message(%Message{channel_id: channel_id}) when not is_nil(channel_id) do
    case get_room_for_channel(channel_id) do
      %Room{} = room -> {:ok, room}
      nil -> {:error, :room_not_found}
    end
  end

  defp room_for_message(%Message{conversation_id: conversation_id})
       when not is_nil(conversation_id) do
    case get_room_for_conversation(conversation_id) do
      %Room{} = room -> {:ok, room}
      nil -> {:error, :room_not_found}
    end
  end

  defp room_for_message(_message), do: {:error, :room_not_found}

  defp ensure_message_event(%Room{} = room, %Message{} = message) do
    case Repo.get_by(RoomEvent, message_id: message.id) do
      %RoomEvent{} = event ->
        {:ok, event}

      nil ->
        %RoomEvent{}
        |> RoomEvent.changeset(%{
          room_id: room.id,
          sender_id: message.sender_id,
          message_id: message.id,
          event_type: "vesper.message",
          content: message_content(message),
          ciphertext: message.ciphertext,
          encryption_algorithm: if(message.ciphertext, do: "mls"),
          mls_epoch: message.mls_epoch
        })
        |> Repo.insert()
    end
  end

  defp maybe_create_thread_relation(%RoomEvent{} = event, %Message{parent_message_id: nil}) do
    {:ok, event}
  end

  defp maybe_create_thread_relation(%RoomEvent{} = event, %Message{} = message) do
    case Repo.get_by(RoomEvent, message_id: message.parent_message_id) do
      nil ->
        {:ok, event}

      %RoomEvent{} = parent_event ->
        case Repo.get_by(RoomRelation,
               event_id: event.id,
               related_event_id: parent_event.id,
               relation_type: "vesper.thread"
             ) do
          %RoomRelation{} ->
            {:ok, event}

          nil ->
            %RoomRelation{}
            |> RoomRelation.changeset(%{
              room_id: event.room_id,
              event_id: event.id,
              related_event_id: parent_event.id,
              sender_id: message.sender_id,
              relation_type: "vesper.thread",
              content: %{}
            })
            |> Repo.insert()
            |> case do
              {:ok, _relation} -> {:ok, event}
              {:error, changeset} -> {:error, changeset}
            end
        end
    end
  end

  defp message_content(%Message{} = message) do
    %{}
    |> maybe_put("parent_message_id", message.parent_message_id)
    |> maybe_put("edited_at", message.edited_at)
    |> maybe_put("expires_at", message.expires_at)
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)
end
