defmodule VesperWeb.ConversationController do
  use VesperWeb, :controller
  alias Vesper.Chat
  alias Vesper.Sync
  import VesperWeb.ControllerHelpers, only: [parse_bool: 2, parse_int: 2]

  def create(conn, %{"participant_ids" => participant_ids} = params) do
    user = conn.assigns.current_user
    opts = if params["name"], do: [name: params["name"]], else: []

    case Chat.create_conversation(user.id, participant_ids, opts) do
      {:ok, conversation} ->
        Sync.append_scope_events(
          Enum.map(conversation.participants, & &1.user_id),
          "conversation_upsert",
          "dm",
          conversation.id
        )

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
        after_seq = parse_int(params["after_seq"], -1)
        lean = parse_bool(params["lean"], false)
        opts = [limit: min(parse_int(params["limit"], 50), 100)]

        opts =
          case params["before"] do
            nil -> opts
            before -> Keyword.put(opts, :before, before)
          end

        opts =
          case params["after"] do
            nil -> opts
            after_cursor -> Keyword.put(opts, :after, after_cursor)
          end

        opts =
          if lean do
            Keyword.put(opts, :lean, true)
          else
            opts
          end

        messages =
          if after_seq >= 0 do
            Chat.list_conversation_messages_after_seq(conversation_id, after_seq, opts)
          else
            Chat.list_conversation_messages(conversation_id, opts)
          end

        json(conn, %{messages: Enum.map(messages, &message_json(&1, lean: lean))})
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
      channel_id: conversation.channel_id,
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

  defp message_json(message, opts \\ []) do
    lean = Keyword.get(opts, :lean, false)

    base = %{
      id: message.id,
      room_seq: message.room_seq,
      conversation_id: message.conversation_id,
      client_nonce: message.client_nonce,
      sender_id: message.sender_id,
      sender: sender_json(message.sender),
      expires_at: message.expires_at,
      parent_message_id: message.parent_message_id,
      thread_root_message_id: message.thread_root_message_id,
      reply_to_message_id: message.reply_to_message_id,
      is_reply: message.is_reply,
      inserted_at: message.inserted_at
    }

    base =
      if lean do
        base
      else
        Map.merge(base, %{
          attachments: attachments_json(message),
          reactions: reactions_json(message)
        })
      end

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

  defp reactions_json(%{reactions: reactions}) when is_list(reactions) do
    Enum.map(reactions, fn r ->
      %{
        id: r.id,
        emoji: r.emoji,
        ciphertext: r.ciphertext,
        mls_epoch: r.mls_epoch,
        sender_id: r.sender_id,
        inserted_at: r.inserted_at
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
