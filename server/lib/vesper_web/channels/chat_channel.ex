defmodule VesperWeb.ChatChannel do
  use Phoenix.Channel

  alias Vesper.Servers
  alias Vesper.Servers.{MemberCache, Permissions, PermissionsCache}
  alias Vesper.Chat
  alias Vesper.Runtime
  alias Vesper.Sync
  alias VesperWeb.ScopeSummary
  import VesperWeb.ChannelHelpers

  @impl true
  def join("chat:channel:" <> channel_id, _payload, socket) do
    case Servers.get_channel_if_member(channel_id, socket.assigns.user_id) do
      nil ->
        {:error, %{reason: "channel not found or not a member"}}

      channel ->
        if Servers.user_can_view_channel?(socket.assigns.user_id, channel) do
          # Subscribe to TTL changes so cached value stays in sync
          Phoenix.PubSub.subscribe(Vesper.PubSub, "channel:settings:#{channel_id}")
          Phoenix.PubSub.subscribe(Vesper.PubSub, "server:members:#{channel.server_id}")

          socket =
            socket
            |> assign(:channel_id, channel_id)
            |> assign(:server_id, channel.server_id)
            |> assign(:disappearing_ttl, channel.disappearing_ttl)

          {:ok, socket}
        else
          {:error, %{reason: "insufficient permissions"}}
        end
    end
  end

  @impl true
  def handle_in(
        "new_message",
        %{"ciphertext" => ciphertext, "mls_epoch" => epoch} = params,
        socket
      ) do
    client_nonce =
      case Map.get(params, "client_nonce") do
        value when is_binary(value) and value != "" -> value
        _ -> nil
      end

    start_time = System.monotonic_time()

    if Servers.user_can_send_messages_in_channel?(
         socket.assigns.user_id,
         socket.assigns.channel_id
       ) do
      with {:ok, decoded} <- safe_decode64(ciphertext),
           {:ok, parent_message_id} <-
             resolve_parent_message_id(params, :channel_id, socket.assigns.channel_id) do
        attrs =
          %{
            ciphertext: decoded,
            mls_epoch: epoch,
            channel_id: socket.assigns.channel_id,
            sender_id: socket.assigns.user_id
          }
          |> maybe_add_parent_id(parent_message_id)
          |> maybe_add_expires_at(socket.assigns.disappearing_ttl)

        case Chat.create_message(attrs) do
          {:ok, message} ->
            message = maybe_link_attachments(message, params)
            mentioned = params["mentioned_user_ids"]

            append_channel_urgent_events(
              message,
              socket.assigns.user_id,
              normalize_mentioned_user_ids(mentioned, socket.assigns.user_id)
            )

            broadcast!(
              socket,
              "new_message",
              encrypted_message_payload(
                message,
                :channel_id,
                if(client_nonce, do: %{client_nonce: client_nonce}, else: %{})
              )
            )

            :telemetry.execute(
              [:vesper, :chat, :message, :send],
              %{duration: System.monotonic_time() - start_time},
              %{channel_id: socket.assigns.channel_id}
            )

            notify_scope_mutation(
              socket.assigns.server_id,
              "channel",
              socket.assigns.channel_id
            )

            channel_id = socket.assigns.channel_id
            sender_id = socket.assigns.user_id
            server_id = socket.assigns.server_id
            member_ids = MemberCache.get_member_ids(server_id)

            notify_unread(channel_id, message, sender_id, member_ids)
            notify_mentions(mentioned, channel_id, sender_id, server_id, member_ids)
            ScopeSummary.broadcast_channel_update(channel_id, message, member_ids)

            {:reply, :ok, socket}

          {:error, _changeset} ->
            {:reply, {:error, %{reason: "could not send message"}}, socket}
        end
      else
        {:error, :missing} ->
          {:reply, {:error, %{reason: "invalid encoding"}}, socket}

        {:error, :invalid_base64} ->
          {:reply, {:error, %{reason: "invalid encoding"}}, socket}

        {:error, :invalid_type} ->
          {:reply, {:error, %{reason: "invalid encoding"}}, socket}

        {:error, reason} when is_binary(reason) ->
          {:reply, {:error, %{reason: reason}}, socket}
      end
    else
      {:reply, {:error, %{reason: "insufficient permissions"}}, socket}
    end
  end

  # Encrypted reactions: client sends {ciphertext, mls_epoch} instead of emoji.
  # The server stores the ciphertext and broadcasts it; only group members can decrypt.
  def handle_in(
        "add_reaction",
        %{"message_id" => message_id, "ciphertext" => ciphertext} = payload,
        socket
      ) do
    mls_epoch = Map.get(payload, "mls_epoch")

    case handle_reaction(
           :add,
           message_id,
           "encrypted",
           socket.assigns.user_id,
           :channel_id,
           socket.assigns.channel_id,
           %{ciphertext: ciphertext, mls_epoch: mls_epoch}
         ) do
      :ok ->
        payload = %{
          action: "add",
          message_id: message_id,
          ciphertext: ciphertext,
          mls_epoch: mls_epoch,
          sender_id: socket.assigns.user_id
        }

        room_seq =
          Runtime.append_scope_event(
            "channel",
            socket.assigns.channel_id,
            socket.assigns.user_id,
            "reaction_update",
            payload
          )
          |> case do
            {:ok, event} -> event.room_seq
            _ -> nil
          end

        broadcast!(socket, "reaction_update", Map.put(payload, :room_seq, room_seq))
        notify_scope_mutation(socket.assigns.server_id, "channel", socket.assigns.channel_id)

        {:reply, :ok, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  # Plaintext fallback for non-E2EE reactions
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
        payload = %{
          action: "add",
          message_id: message_id,
          emoji: emoji,
          sender_id: socket.assigns.user_id
        }

        room_seq =
          Runtime.append_scope_event(
            "channel",
            socket.assigns.channel_id,
            socket.assigns.user_id,
            "reaction_update",
            payload
          )
          |> case do
            {:ok, event} -> event.room_seq
            _ -> nil
          end

        broadcast!(socket, "reaction_update", Map.put(payload, :room_seq, room_seq))
        notify_scope_mutation(socket.assigns.server_id, "channel", socket.assigns.channel_id)

        {:reply, :ok, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  # Encrypted remove: client sends ciphertext of the emoji to remove
  def handle_in(
        "remove_reaction",
        %{"message_id" => message_id, "ciphertext" => ciphertext} = payload,
        socket
      ) do
    mls_epoch = Map.get(payload, "mls_epoch")

    case handle_reaction(
           :remove_encrypted,
           message_id,
           nil,
           socket.assigns.user_id,
           :channel_id,
           socket.assigns.channel_id,
           %{ciphertext: ciphertext, mls_epoch: mls_epoch}
         ) do
      :ok ->
        payload = %{
          action: "remove",
          message_id: message_id,
          ciphertext: ciphertext,
          mls_epoch: mls_epoch,
          sender_id: socket.assigns.user_id
        }

        room_seq =
          Runtime.append_scope_event(
            "channel",
            socket.assigns.channel_id,
            socket.assigns.user_id,
            "reaction_update",
            payload
          )
          |> case do
            {:ok, event} -> event.room_seq
            _ -> nil
          end

        broadcast!(socket, "reaction_update", Map.put(payload, :room_seq, room_seq))
        notify_scope_mutation(socket.assigns.server_id, "channel", socket.assigns.channel_id)

        {:reply, :ok, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  # Plaintext fallback
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
        payload = %{
          action: "remove",
          message_id: message_id,
          emoji: emoji,
          sender_id: socket.assigns.user_id
        }

        room_seq =
          Runtime.append_scope_event(
            "channel",
            socket.assigns.channel_id,
            socket.assigns.user_id,
            "reaction_update",
            payload
          )
          |> case do
            {:ok, event} -> event.room_seq
            _ -> nil
          end

        broadcast!(socket, "reaction_update", Map.put(payload, :room_seq, room_seq))
        notify_scope_mutation(socket.assigns.server_id, "channel", socket.assigns.channel_id)

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
        room_seq =
          Runtime.append_scope_event(
            "channel",
            socket.assigns.channel_id,
            socket.assigns.user_id,
            "message_edited",
            payload
          )
          |> case do
            {:ok, event} -> event.room_seq
            _ -> nil
          end

        broadcast!(socket, "message_edited", Map.put(payload, :room_seq, room_seq))
        notify_scope_mutation(socket.assigns.server_id, "channel", socket.assigns.channel_id)
        {:reply, :ok, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  def handle_in("delete_message", %{"message_id" => id}, socket) do
    case handle_delete_message(id, socket.assigns.user_id) do
      {:ok, _deleted_message} ->
        latest_message = Chat.get_latest_channel_message(socket.assigns.channel_id)

        payload = %{
          message_id: id,
          channel_id: socket.assigns.channel_id,
          latest_message: activity_message_json(latest_message)
        }

        room_seq =
          Runtime.append_scope_event(
            "channel",
            socket.assigns.channel_id,
            socket.assigns.user_id,
            "message_deleted",
            payload
          )
          |> case do
            {:ok, event} -> event.room_seq
            _ -> nil
          end

        broadcast!(socket, "message_deleted", Map.put(payload, :room_seq, room_seq))
        notify_scope_mutation(socket.assigns.server_id, "channel", socket.assigns.channel_id)

        ScopeSummary.broadcast_channel_update(
          socket.assigns.channel_id,
          latest_message,
          MemberCache.get_member_ids(socket.assigns.server_id)
        )

        {:reply, :ok, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  def handle_in("pin_message", %{"message_id" => message_id}, socket) do
    channel_id = socket.assigns.channel_id
    user_id = socket.assigns.user_id
    server_id = socket.assigns.server_id

    if PermissionsCache.has_permission?(user_id, server_id, Permissions.manage_messages()) do
      case Chat.pin_message(channel_id, message_id, user_id) do
        {:ok, _pin} ->
          payload = %{
            channel_id: channel_id,
            message_id: message_id,
            pinned_by: user_id
          }

          room_seq =
            Runtime.append_scope_event(
              "channel",
              channel_id,
              socket.assigns.user_id,
              "message_pinned",
              payload
            )
            |> case do
              {:ok, event} -> event.room_seq
              _ -> nil
            end

          broadcast!(socket, "message_pinned", Map.put(payload, :room_seq, room_seq))
          notify_scope_mutation(server_id, "channel", channel_id)

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
    user_id = socket.assigns.user_id
    server_id = socket.assigns.server_id

    if PermissionsCache.has_permission?(user_id, server_id, Permissions.manage_messages()) do
      case Chat.unpin_message(channel_id, message_id) do
        {:ok, _} ->
          payload = %{
            channel_id: channel_id,
            message_id: message_id
          }

          room_seq =
            Runtime.append_scope_event(
              "channel",
              channel_id,
              socket.assigns.user_id,
              "message_unpinned",
              payload
            )
            |> case do
              {:ok, event} -> event.room_seq
              _ -> nil
            end

          broadcast!(socket, "message_unpinned", Map.put(payload, :room_seq, room_seq))
          notify_scope_mutation(server_id, "channel", channel_id)

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
    user_id = socket.assigns.user_id
    server_id = socket.assigns.server_id

    if PermissionsCache.has_permission?(user_id, server_id, Permissions.manage_channels()) do
      parsed_ttl = if is_integer(ttl) and ttl > 0, do: ttl, else: nil

      case Servers.update_channel_ttl(channel_id, parsed_ttl) do
        {:ok, _} ->
          broadcast!(socket, "disappearing_ttl_updated", %{
            channel_id: channel_id,
            disappearing_ttl: parsed_ttl
          })

          {:reply, :ok, assign(socket, :disappearing_ttl, parsed_ttl)}

        {:error, _} ->
          {:reply, {:error, %{reason: "could not update TTL"}}, socket}
      end
    else
      {:reply, {:error, %{reason: "insufficient permissions"}}, socket}
    end
  end

  def handle_in("typing_start", _payload, socket) do
    broadcast_from!(socket, "typing_start", typing_start_payload(socket))
    {:noreply, socket}
  end

  def handle_in("typing_stop", _payload, socket) do
    broadcast_from!(socket, "typing_stop", %{user_id: socket.assigns.user_id})
    {:noreply, socket}
  end

  def handle_in(_event, _payload, socket),
    do: {:reply, {:error, %{reason: "unrecognized event"}}, socket}

  @impl true
  def handle_info({:ttl_changed, ttl}, socket) do
    {:noreply, assign(socket, :disappearing_ttl, ttl)}
  end

  def handle_info({:member_left, server_id, user_id}, socket)
      when server_id == socket.assigns.server_id and user_id == socket.assigns.user_id do
    {:stop, {:shutdown, :membership_revoked}, socket}
  end

  def handle_info(_msg, socket), do: {:noreply, socket}


  defp maybe_add_expires_at(attrs, ttl) when is_integer(ttl) and ttl > 0 do
    expires_at =
      DateTime.utc_now()
      |> DateTime.add(ttl, :second)
      |> DateTime.truncate(:second)

    Map.put(attrs, :expires_at, expires_at)
  end

  defp maybe_add_expires_at(attrs, _ttl), do: attrs

  defp normalize_mentioned_user_ids(mentioned_user_ids, sender_id)
       when is_list(mentioned_user_ids) do
    mentioned_user_ids
    |> Enum.filter(&(is_binary(&1) and &1 not in [sender_id, "everyone"]))
    |> Enum.uniq()
  end

  defp normalize_mentioned_user_ids(_mentioned_user_ids, _sender_id), do: []

  defp append_channel_urgent_events(message, sender_id, mentioned_user_ids) do
    reply_target_user_id =
      case message.parent_message_id && Chat.get_message(message.parent_message_id) do
        %{sender_id: parent_sender_id}
        when is_binary(parent_sender_id) and parent_sender_id != sender_id ->
          parent_sender_id

        _ ->
          nil
      end

    urgent_targets =
      mentioned_user_ids
      |> Enum.reduce(%{}, fn user_id, acc ->
        Map.put(acc, user_id, %{
          mentions_you: true,
          reply_to_you: user_id == reply_target_user_id,
          urgent_reason: if(user_id == reply_target_user_id, do: "mention_reply", else: "mention")
        })
      end)
      |> then(fn targets ->
        if is_binary(reply_target_user_id) and not Map.has_key?(targets, reply_target_user_id) do
          Map.put(targets, reply_target_user_id, %{
            mentions_you: false,
            reply_to_you: true,
            urgent_reason: "reply"
          })
        else
          targets
        end
      end)

    urgent_events =
      Enum.map(urgent_targets, fn {user_id, flags} ->
        %{
          user_id: user_id,
          scope_kind: "channel",
          scope_id: message.channel_id,
          payload: %{
            message_id: message.id,
            room_seq: message.room_seq,
            sender_id: message.sender_id,
            sender: sender_json(message.sender),
            parent_message_id: message.parent_message_id,
            urgent_reason: flags.urgent_reason,
            mentions_you: flags.mentions_you,
            reply_to_you: flags.reply_to_you,
            is_dm: false
          }
        }
      end)

    Sync.append_urgent_events(urgent_events)
  end
end
