defmodule VesperWeb.ConversationPayload do
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

    {conversations, users}
  end

  defp compact_last_message(nil, users), do: {nil, users}

  defp compact_last_message(message, users) do
    {Map.delete(message, :sender), put_user(users, message.sender)}
  end

  defp put_user(users, nil), do: users
  defp put_user(users, %{id: id} = user), do: Map.put_new(users, id, user)
end
