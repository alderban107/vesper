defmodule VesperWeb.ChatChannel do
  use Phoenix.Channel
  require Logger

  alias Vesper.Servers
  alias Vesper.Servers.{Channel, MemberCache, Permissions, PermissionsCache}
  alias Vesper.Chat
  alias Vesper.Runtime
  alias Vesper.Sync
  alias VesperWeb.ScopeSummary
  alias VesperWeb.MlsHandler
  import VesperWeb.ChannelHelpers

  defp mls_scope(socket),
    do: %{
      kind: "channel",
      group_id: socket.assigns.channel_id,
      resource_id: socket.assigns.channel_id,
      id_key: :channel_id,
      topic: "chat:channel:#{socket.assigns.channel_id}"
    }

  @impl true
  def join("chat:channel:" <> channel_id, _payload, socket) do
    case Servers.get_channel_if_member(channel_id, socket.assigns.user_id) do
      nil ->
        {:error, %{reason: "channel not found or not a member"}}

      channel ->
        if Servers.user_can_view_channel?(socket.assigns.user_id, channel) do
          # Subscribe to TTL changes so cached value stays in sync
          Phoenix.PubSub.subscribe(Vesper.PubSub, "channel:settings:#{channel_id}")

          if channel.server_id do
            Phoenix.PubSub.subscribe(Vesper.PubSub, "server:members:#{channel.server_id}")
          end

          socket =
            socket
            |> assign(:channel_id, channel_id)
            |> assign(:server_id, channel.server_id)
            |> assign(:disappearing_ttl, channel.disappearing_ttl)

          # Schedule replay of missed mls_request_join_all events after join completes
          send(self(), :replay_mls_join_broadcasts)

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
           {:ok, relations} <-
             resolve_message_relations(params, :channel_id, socket.assigns.channel_id) do
        attrs =
          %{
            ciphertext: decoded,
            client_nonce: client_nonce,
            mls_epoch: epoch,
            encryption_scheme: Map.get(params, "encryption_scheme", "mls"),
            encryption_group_id: Map.get(params, "encryption_group_id"),
            channel_id: socket.assigns.channel_id,
            sender_id: socket.assigns.user_id,
            parent_message_id: relations.parent_message_id,
            thread_root_message_id: relations.thread_root_message_id,
            reply_to_message_id: relations.reply_to_message_id,
            is_reply: relations.is_reply
          }
          |> maybe_add_expires_at(socket.assigns.disappearing_ttl)

        dispatch = fn message, event ->
          %{
            durable_key: "room_event:#{event.id}",
            scope_key: "channel:#{socket.assigns.channel_id}",
            scope_topic: "chat:channel:#{socket.assigns.channel_id}",
            ordering_key: event.room_seq,
            event: "new_message",
            payload:
              encrypted_message_payload(
                message,
                :channel_id,
                if(client_nonce, do: %{client_nonce: client_nonce}, else: %{})
              )
          }
        end

        case Chat.create_message(attrs,
               attachment_ids: Map.get(params, "attachment_ids", []),
               dispatch: dispatch
             ) do
          {:ok, message} ->
            mentioned = params["mentioned_user_ids"]
            channel_id = socket.assigns.channel_id
            sender_id = socket.assigns.user_id
            server_id = socket.assigns.server_id

            :telemetry.execute(
              [:vesper, :chat, :message, :send],
              %{duration: System.monotonic_time() - start_time},
              %{channel_id: channel_id}
            )

            if server_id do
              # Server channel: full server-level notifications
              append_channel_urgent_events(
                message,
                sender_id,
                normalize_mentioned_user_ids(mentioned, sender_id)
              )

              notify_scope_mutation(server_id, "channel", channel_id)

              notify_scope_mutation(server_id, "channel", channel_id, %{
                message_id: message.id,
                sender_id: sender_id,
                sender: sender_json(message.sender),
                inserted_at: message.inserted_at,
                room_seq: message.room_seq
              })

              member_ids =
                if mentioned != [], do: MemberCache.get_member_ids(server_id), else: MapSet.new()

              notify_mentions(mentioned, channel_id, sender_id, server_id, member_ids)

              # Push notifications for offline @mentioned users
              if mentioned && mentioned != [] do
                resolved =
                  if "everyone" in mentioned do
                    MapSet.to_list(member_ids)
                  else
                    mentioned |> Enum.reject(&(&1 == "everyone"))
                  end

                Vesper.Notifications.notify_mentioned_users(
                  resolved,
                  sender_id,
                  channel_id,
                  server_id
                )
              end
            else
              # DM channel: send dm_activity to each member's user channel
              notify_dm_channel_activity(channel_id, sender_id, message)
            end

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
           %{
             ciphertext: ciphertext,
             mls_epoch: mls_epoch,
             encryption_scheme: Map.get(payload, "encryption_scheme", "mls"),
             encryption_group_id: Map.get(payload, "encryption_group_id")
           }
         ) do
      :ok ->
        payload = %{
          action: "add",
          message_id: message_id,
          ciphertext: ciphertext,
          mls_epoch: mls_epoch,
          encryption_scheme: Map.get(payload, "encryption_scheme", "mls"),
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
           %{
             ciphertext: ciphertext,
             mls_epoch: mls_epoch,
             encryption_scheme: Map.get(payload, "encryption_scheme", "mls"),
             encryption_group_id: Map.get(payload, "encryption_group_id")
           }
         ) do
      :ok ->
        payload = %{
          action: "remove",
          message_id: message_id,
          ciphertext: ciphertext,
          mls_epoch: mls_epoch,
          encryption_scheme: Map.get(payload, "encryption_scheme", "mls"),
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
        %{"message_id" => id, "ciphertext" => ciphertext, "mls_epoch" => epoch} = params,
        socket
      ) do
    case handle_edit_message(
           id,
           ciphertext,
           epoch,
           Map.get(params, "encryption_scheme", "mls"),
           Map.get(params, "encryption_group_id"),
           socket
         ) do
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

        member_ids =
          if socket.assigns.server_id do
            MemberCache.get_member_ids(socket.assigns.server_id)
          else
            channel = Servers.get_channel(socket.assigns.channel_id)
            Servers.list_channel_member_ids(channel) |> MapSet.new()
          end

        ScopeSummary.broadcast_channel_update(
          socket.assigns.channel_id,
          latest_message,
          member_ids
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

  def handle_in("mls_request_join", payload, socket) when is_map(payload) do
    MlsHandler.handle_mls_request_join(payload, socket)
  end

  def handle_in("mls_request_join_all", _payload, socket) do
    MlsHandler.handle_mls_request_join_all(socket, mls_scope(socket))
  end

  def handle_in("mls_resync_request", payload, socket) when is_map(payload) do
    MlsHandler.handle_mls_resync_request(payload, socket, mls_scope(socket))
  end

  def handle_in("mls_commit", %{"commit_data" => commit_data} = payload, socket)
      when is_binary(commit_data) do
    MlsHandler.handle_mls_commit(payload, socket, mls_scope(socket))
  end

  def handle_in("mls_eviction_claim", %{"id" => eviction_id} = payload, socket)
      when is_binary(eviction_id) do
    MlsHandler.handle_mls_eviction_claim(payload, socket, mls_scope(socket))
  end

  def handle_in("mls_eviction_skip", %{"id" => eviction_id} = payload, socket)
      when is_binary(eviction_id) do
    MlsHandler.handle_mls_eviction_skip(payload, socket, mls_scope(socket))
  end

  def handle_in(
        "mls_remove",
        %{"removed_user_id" => removed_user_id, "commit_data" => commit_data} = payload,
        socket
      )
      when is_binary(removed_user_id) and is_binary(commit_data) do
    MlsHandler.handle_mls_remove(payload, socket, mls_scope(socket))
  end

  def handle_in(
        "mls_welcome",
        %{"recipient_id" => recipient_id, "welcome_data" => welcome_data} = payload,
        socket
      )
      when is_binary(recipient_id) and is_binary(welcome_data) do
    MlsHandler.handle_mls_welcome(payload, socket, mls_scope(socket))
  end

  def handle_in("mls_history_request", payload, socket) do
    MlsHandler.handle_mls_history_request(payload, socket, mls_scope(socket), fn ->
      notify_history_request_pending(
        socket.assigns.server_id,
        socket.assigns.channel_id,
        socket.assigns.user_id,
        "chat:channel:#{socket.assigns.channel_id}"
      )
    end)
  end

  def handle_in(
        "mls_history_bundle",
        %{
          "ciphertext" => _ciphertext,
          "mls_epoch" => _epoch,
          "recipient_id" => _recipient_id
        } = payload,
        socket
      ) do
    MlsHandler.handle_mls_history_bundle(payload, socket, mls_scope(socket))
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

  def handle_info(:replay_mls_join_broadcasts, socket) do
    MlsHandler.replay_mls_join_broadcasts(socket, socket.assigns.channel_id)
    {:noreply, socket}
  end

  def handle_info(_msg, socket), do: {:noreply, socket}

  # --- Private ---

  defp notify_mentions(nil, _channel_id, _sender_id, _server_id, _member_ids), do: :ok
  defp notify_mentions([], _channel_id, _sender_id, _server_id, _member_ids), do: :ok

  defp notify_mentions(mentioned_user_ids, channel_id, sender_id, server_id, member_ids)
       when is_list(mentioned_user_ids) do
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
      if PermissionsCache.has_permission?(sender_id, server_id, Permissions.mention_everyone()) do
        for uid <- member_ids, uid != sender_id do
          VesperWeb.Endpoint.broadcast("user:#{uid}", "mention", %{
            channel_id: channel_id,
            sender_id: sender_id
          })
        end
      end
    end
  end

  # Guard against clients sending a non-list value (e.g. a bare string) for mentioned_user_ids.
  defp notify_mentions(_non_list, _channel_id, _sender_id, _server_id, _member_ids), do: :ok

  # DM channels have no server_id — broadcast scope_mutation to each member's
  # user channel instead of the server presence topic.
  # Header clause needed because of the default argument.
  defp notify_scope_mutation(server_id, kind, scope_id, activity \\ nil)

  defp notify_scope_mutation(nil, _kind, scope_id, activity) do
    # Resolve DM conversation_id so clients get kind=dm, scope_id=conversation_id
    {dm_kind, dm_scope_id} =
      case Chat.get_dm_context_for_channel(scope_id) do
        {conversation_id, _} -> {"dm", conversation_id}
        _ -> {"channel", scope_id}
      end

    payload = %{kind: dm_kind, scope_id: dm_scope_id}
    payload = if activity, do: Map.put(payload, :activity, activity), else: payload

    # Broadcast to the DM scope topic (clients subscribe for warm scopes)
    VesperWeb.Endpoint.broadcast("scope:dm:#{dm_scope_id}", "scope_mutation", payload)

    # Also notify each member's user channel for sidebar/unread on non-warm scopes.
    member_ids = fetch_dm_member_ids(scope_id)

    Enum.each(member_ids, fn user_id ->
      VesperWeb.Endpoint.broadcast("user:#{user_id}", "scope_mutation", payload)
    end)

    :ok
  end

  defp notify_scope_mutation(server_id, kind, scope_id, activity) do
    payload = %{
      kind: kind,
      scope_id: scope_id
    }

    payload =
      if activity do
        Map.put(payload, :activity, activity)
      else
        payload
      end

    VesperWeb.Endpoint.broadcast("presence:server:#{server_id}", "scope_mutation", payload)

    :ok
  end

  defp notify_history_request_pending(server_id, channel_id, _requester_id, topic) do
    member_ids =
      case Servers.get_channel(channel_id) do
        %Channel{server_id: nil} = channel ->
          Servers.list_channel_member_ids(channel)

        _ ->
          Servers.list_member_ids(server_id)
      end

    member_ids
    |> Enum.filter(&Servers.user_can_view_channel?(&1, channel_id))
    |> Enum.each(fn user_id ->
      VesperWeb.Endpoint.broadcast("user:#{user_id}", "mls_history_request_pending", %{
        scope_id: channel_id,
        topic: topic
      })
    end)

    :ok
  end

  # DM channel notification: looks up the backing conversation and sends
  # dm_activity + urgent events to each participant, mirroring dm_channel.ex.
  defp notify_dm_channel_activity(channel_id, sender_id, message) do
    case Chat.get_dm_context_for_channel(channel_id) do
      {conversation_id, participant_ids} ->
        sender_info = sender_json(message.sender)

        # Urgent events for background sync (unread indicators on reconnect)
        urgent_events =
          participant_ids
          |> Enum.reject(&(&1 == sender_id))
          |> Enum.map(fn user_id ->
            %{
              user_id: user_id,
              scope_kind: "dm",
              scope_id: conversation_id,
              payload: %{
                message_id: message.id,
                room_seq: message.room_seq,
                sender_id: sender_id,
                sender: sender_info,
                parent_message_id: message.parent_message_id,
                urgent_reason: "dm",
                mentions_you: false,
                reply_to_you: false,
                is_dm: true
              }
            }
          end)

        Sync.append_urgent_events(urgent_events)

        # Per-user dm_activity broadcast (drives unread badge + sidebar update)
        dm_activity_payload = %{
          conversation_id: conversation_id,
          message_id: message.id,
          sender_id: sender_id,
          sender: sender_info,
          inserted_at: message.inserted_at,
          scope_summary: %{
            kind: "dm",
            scope_id: conversation_id,
            room_seq: message.room_seq,
            conversation_reset: ScopeSummary.conversation_reset_json(conversation_id, message)
          }
        }

        for uid <- participant_ids, uid != sender_id do
          VesperWeb.Endpoint.broadcast("user:#{uid}", "dm_activity", dm_activity_payload)
        end

      _ ->
        :ok
    end
  end

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
            thread_root_message_id: message.thread_root_message_id,
            reply_to_message_id: message.reply_to_message_id,
            urgent_reason: flags.urgent_reason,
            mentions_you: flags.mentions_you,
            reply_to_you: flags.reply_to_you,
            is_dm: false
          }
        }
      end)

    Sync.append_urgent_events(urgent_events)
  end

  defp fetch_dm_member_ids(channel_id) do
    Servers.list_dm_channel_member_ids(channel_id)
  end
end
