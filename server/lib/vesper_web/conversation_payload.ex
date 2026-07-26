defmodule VesperWeb.ConversationPayload do
  def message_preview(nil), do: nil

  def message_preview(message) do
    base = %{
      id: message.id,
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

  def compact(conversations) when is_list(conversations) do
    {conversations, users} =
      Enum.map_reduce(conversations, %{}, fn conversation, users ->
        {participants, users} =
          Enum.map_reduce(conversation.participants, users, fn participant, acc ->
            {Map.delete(participant, :user), put_user(acc, participant.user)}
          end)

        {last_message, users} = compact_last_message(conversation.last_message, users)

        {%{conversation | participants: participants, last_message: last_message}, users}
      end)

    {conversations, users |> Map.values() |> Enum.sort_by(& &1.id)}
  end

  defp compact_last_message(nil, users), do: {nil, users}

  defp compact_last_message(message, users) do
    {Map.delete(message, :sender), put_user(users, message.sender)}
  end

  defp put_user(users, nil), do: users
  defp put_user(users, %{id: id} = user), do: Map.put_new(users, id, user)

  defp sender_json(nil), do: nil

  defp sender_json(sender) do
    %{
      id: sender.id,
      username: sender.username,
      display_name: sender.display_name,
      avatar_url: sender.avatar_url
    }
  end
end
