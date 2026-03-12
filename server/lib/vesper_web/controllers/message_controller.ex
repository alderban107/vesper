defmodule VesperWeb.MessageController do
  use VesperWeb, :controller
  alias Vesper.Chat
  alias Vesper.Servers
  import VesperWeb.ControllerHelpers, only: [parse_int: 2]

  def index(conn, %{"id" => channel_id} = params) do
    user = conn.assigns.current_user
    channel = Servers.get_channel(channel_id)

    cond do
      is_nil(channel) ->
        conn |> put_status(:not_found) |> json(%{error: "channel not found"})

      not Servers.user_is_member?(user.id, channel.server_id) ->
        conn |> put_status(:forbidden) |> json(%{error: "not a member"})

      not Servers.user_can_view_channel?(user.id, channel) ->
        conn |> put_status(:forbidden) |> json(%{error: "channel access denied"})

      true ->
        opts = [limit: min(parse_int(params["limit"], 50), 100)]

        opts =
          case params["before"] do
            nil -> opts
            before -> Keyword.put(opts, :before, before)
          end

        messages = Chat.list_channel_messages(channel_id, opts)

        json(conn, %{
          messages: Enum.map(messages, &message_json/1)
        })
    end
  end

  def pins(conn, %{"id" => channel_id}) do
    user = conn.assigns.current_user
    channel = Servers.get_channel(channel_id)

    cond do
      is_nil(channel) ->
        conn |> put_status(:not_found) |> json(%{error: "channel not found"})

      not Servers.user_is_member?(user.id, channel.server_id) ->
        conn |> put_status(:forbidden) |> json(%{error: "not a member"})

      not Servers.user_can_view_channel?(user.id, channel) ->
        conn |> put_status(:forbidden) |> json(%{error: "channel access denied"})

      true ->
        pins = Chat.list_pinned_messages(channel_id)

        json(conn, %{
          pins:
            Enum.map(pins, fn pin ->
              %{
                id: pin.id,
                message: message_json(pin.message),
                pinned_by_id: pin.pinned_by_id,
                inserted_at: pin.inserted_at
              }
            end)
        })
    end
  end

  def mark_read(conn, %{"id" => channel_id} = params) do
    user = conn.assigns.current_user
    message_id = params["message_id"]
    channel = Servers.get_channel(channel_id)

    cond do
      is_nil(message_id) ->
        conn |> put_status(:bad_request) |> json(%{error: "message_id is required"})

      is_nil(channel) ->
        conn |> put_status(:not_found) |> json(%{error: "channel not found"})

      not Servers.user_is_member?(user.id, channel.server_id) ->
        conn |> put_status(:forbidden) |> json(%{error: "not a member"})

      not Servers.user_can_view_channel?(user.id, channel) ->
        conn |> put_status(:forbidden) |> json(%{error: "channel access denied"})

      true ->
        Chat.mark_channel_read(user.id, channel_id, message_id)
        json(conn, %{ok: true})
    end
  end

  def thread(conn, %{"id" => message_id} = params) do
    user = conn.assigns.current_user
    limit = min(parse_int(params["limit"], 100), 200)

    case resolve_thread_parent(message_id) do
      nil ->
        conn |> put_status(:not_found) |> json(%{error: "message not found"})

      parent ->
        cond do
          parent.channel_id ->
            channel = Servers.get_channel(parent.channel_id)

            cond do
              is_nil(channel) ->
                conn |> put_status(:not_found) |> json(%{error: "channel not found"})

              not Servers.user_is_member?(user.id, channel.server_id) ->
                conn |> put_status(:forbidden) |> json(%{error: "not a member"})

              not Servers.user_can_view_channel?(user.id, channel) ->
                conn |> put_status(:forbidden) |> json(%{error: "channel access denied"})

              true ->
                thread_json(conn, parent, limit)
            end

          parent.conversation_id ->
            if Chat.user_is_participant?(user.id, parent.conversation_id) do
              thread_json(conn, parent, limit)
            else
              conn |> put_status(:forbidden) |> json(%{error: "not a participant"})
            end

          true ->
            conn |> put_status(:unprocessable_entity) |> json(%{error: "message has no scope"})
        end
    end
  end

  defp thread_json(conn, parent, limit) do
    replies = Chat.list_thread_messages(parent.id, limit: limit)

    json(conn, %{
      parent: message_json(parent),
      messages: Enum.map(replies, &message_json/1),
      reply_count: Chat.count_thread_replies(parent.id)
    })
  end

  defp resolve_thread_parent(message_id) do
    case Chat.get_message_with_details(message_id) do
      nil ->
        nil

      %{parent_message_id: nil} = message ->
        message

      %{parent_message_id: parent_id} = message ->
        Chat.get_message_with_details(parent_id) || message
    end
  end

  defp message_json(message) do
    base = %{
      id: message.id,
      channel_id: message.channel_id,
      conversation_id: message.conversation_id,
      sender_id: message.sender_id,
      sender: sender_json(message.sender),
      expires_at: message.expires_at,
      parent_message_id: message.parent_message_id,
      inserted_at: message.inserted_at,
      attachments: attachments_json(message)
    }

    # Include ciphertext for encrypted messages, content for plaintext
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
end
