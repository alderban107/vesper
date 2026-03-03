defmodule VesperWeb.MessageController do
  use VesperWeb, :controller
  alias Vesper.Chat
  alias Vesper.Servers

  def index(conn, %{"id" => channel_id} = params) do
    user = conn.assigns.current_user
    channel = Servers.get_channel(channel_id)

    cond do
      is_nil(channel) ->
        conn |> put_status(:not_found) |> json(%{error: "channel not found"})

      not Servers.user_is_member?(user.id, channel.server_id) ->
        conn |> put_status(:forbidden) |> json(%{error: "not a member"})

      true ->
        opts = [limit: min(String.to_integer(params["limit"] || "50"), 100)]

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
    Chat.mark_channel_read(user.id, channel_id, message_id)
    json(conn, %{ok: true})
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
