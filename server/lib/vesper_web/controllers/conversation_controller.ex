defmodule VesperWeb.ConversationController do
  use VesperWeb, :controller
  alias Vesper.Chat

  def create(conn, %{"participant_ids" => participant_ids} = params) do
    user = conn.assigns.current_user
    opts = if params["name"], do: [name: params["name"]], else: []

    case Chat.create_conversation(user.id, participant_ids, opts) do
      {:ok, conversation} ->
        # Notify other participants of the new conversation
        conv_payload = conversation_json(conversation)
        for p <- conversation.participants, p.user_id != user.id do
          VesperWeb.Endpoint.broadcast("user:#{p.user_id}", "new_conversation", %{
            conversation: conv_payload
          })
        end

        conn
        |> put_status(:created)
        |> json(%{conversation: conv_payload})

      {:error, _} ->
        conn
        |> put_status(:unprocessable_entity)
        |> json(%{error: "could not create conversation"})
    end
  end

  def create(conn, _params) do
    conn |> put_status(:bad_request) |> json(%{error: "participant_ids is required"})
  end

  def index(conn, _params) do
    user = conn.assigns.current_user
    results = Chat.list_conversations(user.id)

    json(conn, %{
      conversations:
        Enum.map(results, fn %{conversation: conv, last_message: last_msg} ->
          conversation_json(conv)
          |> Map.put(:last_message, if(last_msg, do: message_json(last_msg), else: nil))
        end)
    })
  end

  def show(conn, %{"id" => id}) do
    user = conn.assigns.current_user

    case Chat.get_conversation(id) do
      nil ->
        conn |> put_status(:not_found) |> json(%{error: "not found"})

      conversation ->
        if Chat.user_is_participant?(user.id, id) do
          json(conn, %{conversation: conversation_json(conversation)})
        else
          conn |> put_status(:forbidden) |> json(%{error: "not a participant"})
        end
    end
  end

  def messages(conn, %{"conversation_id" => conversation_id} = params) do
    user = conn.assigns.current_user

    cond do
      not Chat.user_is_participant?(user.id, conversation_id) ->
        conn |> put_status(:forbidden) |> json(%{error: "not a participant"})

      true ->
        opts = [limit: min(String.to_integer(params["limit"] || "50"), 100)]

        opts =
          case params["before"] do
            nil -> opts
            before -> Keyword.put(opts, :before, before)
          end

        messages = Chat.list_conversation_messages(conversation_id, opts)
        json(conn, %{messages: Enum.map(messages, &message_json/1)})
    end
  end

  def mark_read(conn, %{"conversation_id" => conversation_id} = params) do
    user = conn.assigns.current_user

    if Chat.user_is_participant?(user.id, conversation_id) do
      message_id = params["message_id"]
      Chat.mark_dm_read(user.id, conversation_id, message_id)
      json(conn, %{ok: true})
    else
      conn |> put_status(:forbidden) |> json(%{error: "not a participant"})
    end
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
            Enum.map(participants, fn p ->
              %{
                id: p.id,
                user_id: p.user_id,
                joined_at: p.joined_at,
                user: user_json(p.user)
              }
            end)
        end
    }
  end

  defp message_json(message) do
    base = %{
      id: message.id,
      conversation_id: message.conversation_id,
      sender_id: message.sender_id,
      sender: sender_json(message.sender),
      expires_at: message.expires_at,
      parent_message_id: message.parent_message_id,
      inserted_at: message.inserted_at,
      attachments: attachments_json(message)
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
    Enum.map(attachments, fn a ->
      %{
        id: a.id,
        filename: a.filename,
        content_type: a.content_type,
        size_bytes: a.size_bytes,
        encrypted: a.encrypted
      }
    end)
  end

  defp attachments_json(_), do: []

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
