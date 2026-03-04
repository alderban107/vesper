defmodule VesperWeb.ChatChannel do
  use Phoenix.Channel

  alias Vesper.Servers
  alias Vesper.Chat
  alias Vesper.Encryption
  import VesperWeb.ChannelHelpers

  @impl true
  def join("chat:channel:" <> channel_id, _payload, socket) do
    channel = Servers.get_channel(channel_id)

    cond do
      is_nil(channel) ->
        {:error, %{reason: "channel not found"}}

      not Servers.user_is_member?(socket.assigns.user_id, channel.server_id) ->
        {:error, %{reason: "not a member"}}

      true ->
        socket = assign(socket, :channel_id, channel_id)
        {:ok, socket}
    end
  end

  @impl true
  def handle_in(
        "new_message",
        %{"ciphertext" => ciphertext, "mls_epoch" => epoch} = params,
        socket
      ) do
    case safe_decode64(ciphertext) do
      {:ok, decoded} ->
        attrs =
          %{
            ciphertext: decoded,
            mls_epoch: epoch,
            channel_id: socket.assigns.channel_id,
            sender_id: socket.assigns.user_id
          }
          |> maybe_add_parent(params)

        case Chat.create_message(attrs) do
          {:ok, message} ->
            message = maybe_link_attachments(message, params)
            broadcast!(socket, "new_message", encrypted_message_payload(message, :channel_id))
            notify_unread(socket.assigns.channel_id, message.id, socket.assigns.user_id)

            notify_mentions(
              params["mentioned_user_ids"],
              socket.assigns.channel_id,
              socket.assigns.user_id
            )

            {:reply, :ok, socket}

          {:error, _changeset} ->
            {:reply, {:error, %{reason: "could not send message"}}, socket}
        end

      {:error, _} ->
        {:reply, {:error, %{reason: "invalid encoding"}}, socket}
    end
  end

  def handle_in("add_reaction", %{"message_id" => message_id, "emoji" => emoji}, socket) do
    case handle_reaction(
           :add,
           message_id,
           emoji,
           socket.assigns.user_id,
           :channel_id,
           socket.assigns.channel_id
         ) do
      :ok ->
        broadcast!(socket, "reaction_update", %{
          action: "add",
          message_id: message_id,
          emoji: emoji,
          sender_id: socket.assigns.user_id
        })

        {:reply, :ok, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  def handle_in("remove_reaction", %{"message_id" => message_id, "emoji" => emoji}, socket) do
    case handle_reaction(
           :remove,
           message_id,
           emoji,
           socket.assigns.user_id,
           :channel_id,
           socket.assigns.channel_id
         ) do
      :ok ->
        broadcast!(socket, "reaction_update", %{
          action: "remove",
          message_id: message_id,
          emoji: emoji,
          sender_id: socket.assigns.user_id
        })

        {:reply, :ok, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  def handle_in(
        "edit_message",
        %{"message_id" => id, "ciphertext" => ciphertext, "mls_epoch" => epoch},
        socket
      ) do
    case handle_edit_message(id, ciphertext, epoch, socket) do
      {:ok, payload} ->
        broadcast!(socket, "message_edited", payload)
        {:reply, :ok, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  def handle_in("delete_message", %{"message_id" => id}, socket) do
    case handle_delete_message(id, socket.assigns.user_id) do
      :ok ->
        broadcast!(socket, "message_deleted", %{message_id: id})
        {:reply, :ok, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  def handle_in("pin_message", %{"message_id" => message_id}, socket) do
    channel_id = socket.assigns.channel_id
    channel = Servers.get_channel(channel_id)

    if Servers.user_can?(
         socket.assigns.user_id,
         channel.server_id,
         Vesper.Servers.Permissions.manage_messages()
       ) do
      case Chat.pin_message(channel_id, message_id, socket.assigns.user_id) do
        {:ok, _pin} ->
          broadcast!(socket, "message_pinned", %{
            channel_id: channel_id,
            message_id: message_id,
            pinned_by: socket.assigns.user_id
          })

          {:reply, :ok, socket}

        {:error, _} ->
          {:reply, {:error, %{reason: "could not pin message"}}, socket}
      end
    else
      {:reply, {:error, %{reason: "insufficient permissions"}}, socket}
    end
  end

  def handle_in("unpin_message", %{"message_id" => message_id}, socket) do
    channel_id = socket.assigns.channel_id
    channel = Servers.get_channel(channel_id)

    if Servers.user_can?(
         socket.assigns.user_id,
         channel.server_id,
         Vesper.Servers.Permissions.manage_messages()
       ) do
      case Chat.unpin_message(channel_id, message_id) do
        {:ok, _} ->
          broadcast!(socket, "message_unpinned", %{
            channel_id: channel_id,
            message_id: message_id
          })

          {:reply, :ok, socket}

        {:error, _} ->
          {:reply, {:error, %{reason: "could not unpin message"}}, socket}
      end
    else
      {:reply, {:error, %{reason: "insufficient permissions"}}, socket}
    end
  end

  def handle_in("set_disappearing", %{"ttl" => ttl}, socket) do
    channel_id = socket.assigns.channel_id
    channel = Servers.get_channel(channel_id)
    role = Servers.user_role(socket.assigns.user_id, channel.server_id)

    if role in ~w(owner admin) do
      parsed_ttl = if is_integer(ttl) and ttl > 0, do: ttl, else: nil

      case Servers.update_channel_ttl(channel_id, parsed_ttl) do
        {:ok, _} ->
          broadcast!(socket, "disappearing_ttl_updated", %{
            channel_id: channel_id,
            disappearing_ttl: parsed_ttl
          })

          {:reply, :ok, socket}

        {:error, _} ->
          {:reply, {:error, %{reason: "could not update TTL"}}, socket}
      end
    else
      {:reply, {:error, %{reason: "insufficient permissions"}}, socket}
    end
  end

  def handle_in("typing_start", _payload, socket) do
    broadcast_from!(socket, "typing_start", typing_start_payload(socket.assigns.user_id))
    {:noreply, socket}
  end

  def handle_in("typing_stop", _payload, socket) do
    broadcast_from!(socket, "typing_stop", %{user_id: socket.assigns.user_id})
    {:noreply, socket}
  end

  def handle_in("mls_request_join", _payload, socket) do
    broadcast_from!(socket, "mls_request_join", %{user_id: socket.assigns.user_id})
    {:noreply, socket}
  end

  def handle_in("mls_commit", %{"commit_data" => commit_data}, socket) do
    broadcast!(socket, "mls_commit", %{
      commit_data: commit_data,
      sender_id: socket.assigns.user_id
    })

    {:noreply, socket}
  end

  def handle_in(
        "mls_remove",
        %{"removed_user_id" => removed_user_id, "commit_data" => commit_data},
        socket
      ) do
    broadcast!(socket, "mls_remove", %{
      removed_user_id: removed_user_id,
      commit_data: commit_data,
      sender_id: socket.assigns.user_id
    })

    {:noreply, socket}
  end

  def handle_in(
        "mls_welcome",
        %{"recipient_id" => recipient_id, "welcome_data" => welcome_data},
        socket
      ) do
    case safe_decode64(welcome_data) do
      {:ok, decoded} ->
        channel_id = socket.assigns.channel_id
        sender_id = socket.assigns.user_id

        broadcast!(socket, "mls_welcome", %{
          recipient_id: recipient_id,
          welcome_data: welcome_data,
          sender_id: sender_id
        })

        Encryption.store_pending_welcome(%{
          recipient_id: recipient_id,
          channel_id: channel_id,
          welcome_data: decoded,
          sender_id: sender_id
        })

        {:noreply, socket}

      {:error, _} ->
        {:reply, {:error, %{reason: "invalid encoding"}}, socket}
    end
  end

  defp notify_mentions(nil, _channel_id, _sender_id), do: :ok
  defp notify_mentions([], _channel_id, _sender_id), do: :ok

  defp notify_mentions(mentioned_user_ids, channel_id, sender_id)
       when is_list(mentioned_user_ids) do
    channel = Servers.get_channel(channel_id)
    if is_nil(channel), do: :ok

    if channel do
      has_everyone = "everyone" in mentioned_user_ids

      user_ids =
        mentioned_user_ids |> Enum.reject(&(&1 in [sender_id, "everyone"])) |> Enum.uniq()

      for user_id <- user_ids do
        VesperWeb.Endpoint.broadcast("user:#{user_id}", "mention", %{
          channel_id: channel_id,
          sender_id: sender_id
        })
      end

      if has_everyone do
        if Servers.user_can?(
             sender_id,
             channel.server_id,
             Vesper.Servers.Permissions.mention_everyone()
           ) do
          members = Servers.list_members(channel.server_id)

          for member <- members, member.user_id != sender_id do
            VesperWeb.Endpoint.broadcast("user:#{member.user_id}", "mention", %{
              channel_id: channel_id,
              sender_id: sender_id
            })
          end
        end
      end
    end
  end

  defp notify_mentions(_invalid, _channel_id, _sender_id), do: :ok

  defp notify_unread(channel_id, message_id, sender_id) do
    channel = Servers.get_channel(channel_id)

    if channel do
      members = Servers.list_members(channel.server_id)

      for member <- members, member.user_id != sender_id do
        VesperWeb.Endpoint.broadcast("user:#{member.user_id}", "unread_update", %{
          channel_id: channel_id,
          message_id: message_id
        })
      end
    end
  end
end
