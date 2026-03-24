defmodule VesperWeb.ScopeSummary do
  alias VesperWeb.ChannelHelpers

  def channel_activity_json(channel_id, nil) do
    %{
      channel_id: channel_id,
      message_id: nil,
      inserted_at: nil,
      sender_id: nil,
      sender: nil
    }
  end

  def channel_activity_json(channel_id, message) do
    %{
      channel_id: channel_id,
      message_id: message.id,
      inserted_at: message.inserted_at,
      sender_id: message.sender_id,
      sender: ChannelHelpers.sender_json(message.sender)
    }
  end

  def conversation_reset_json(conversation_id, nil) do
    %{
      conversation_id: conversation_id,
      last_message: nil
    }
  end

  def conversation_reset_json(conversation_id, message) do
    %{
      conversation_id: conversation_id,
      last_message: conversation_message_json(message)
    }
  end

  def broadcast_channel_update(channel_id, message, user_ids) do
    payload = %{
      kind: "channel",
      scope_id: channel_id,
      room_seq: latest_room_seq(message),
      channel_activity: channel_activity_json(channel_id, message)
    }

    broadcast_to_users(user_ids, payload)
  end

  def broadcast_dm_update(conversation_id, message, user_ids) do
    payload = %{
      kind: "dm",
      scope_id: conversation_id,
      room_seq: latest_room_seq(message),
      conversation_reset: conversation_reset_json(conversation_id, message)
    }

    broadcast_to_users(user_ids, payload)
  end

  defp broadcast_to_users(user_ids, payload) do
    user_ids
    |> Enum.uniq()
    |> Enum.each(fn user_id ->
      VesperWeb.Endpoint.broadcast("user:#{user_id}", "scope_summary_updated", payload)
    end)

    :ok
  end

  defp conversation_message_json(message) do
    base = %{
      id: message.id,
      conversation_id: message.conversation_id,
      client_nonce: message.client_nonce,
      sender_id: message.sender_id,
      sender: ChannelHelpers.sender_json(message.sender),
      inserted_at: message.inserted_at
    }

    if message.ciphertext do
      Map.put(base, :ciphertext, "encrypted")
    else
      Map.put(base, :content, message.content)
    end
  end

  defp latest_room_seq(nil), do: nil
  defp latest_room_seq(message), do: Map.get(message, :room_seq)
end
