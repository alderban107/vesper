defmodule VesperWeb.DmChannel do
  use Phoenix.Channel

  alias Vesper.Chat
  alias Vesper.Runtime
  alias Vesper.Sync
  alias Vesper.Voice
  alias VesperWeb.ScopeSummary
  alias VesperWeb.MlsHandler
  import VesperWeb.ChannelHelpers

  defp mls_scope(socket),
    do: %{kind: "dm", id: socket.assigns.conversation_id, id_key: :conversation_id}

  @impl true
  def join("dm:" <> conversation_id, _payload, socket) do
    user_id = socket.assigns.user_id

    if Chat.user_is_participant?(user_id, conversation_id) do
      # Cache participant IDs and sender info on join to avoid per-message DB lookups
      participant_ids = Chat.list_participant_ids(conversation_id)

      sender_info = %{
        id: user_id,
        username: socket.assigns[:username],
        display_name: socket.assigns[:display_name]
      }

      # Subscribe to participant changes for cache invalidation
      Phoenix.PubSub.subscribe(Vesper.PubSub, "dm:participants:#{conversation_id}")

      socket =
        socket
        |> assign(:conversation_id, conversation_id)
        |> assign(:participant_ids, participant_ids)
        |> assign(:sender_info, sender_info)

      # Schedule replay of missed mls_request_join_all events after join completes
      send(self(), :replay_mls_join_broadcasts)

      {:ok, socket}
    else
      {:error, %{reason: "not a participant"}}
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

    with {:ok, decoded} <- safe_decode64(ciphertext),
         {:ok, parent_message_id} <-
           resolve_parent_message_id(params, :conversation_id, socket.assigns.conversation_id) do
      attrs =
        %{
          ciphertext: decoded,
          client_nonce: client_nonce,
          mls_epoch: epoch,
          conversation_id: socket.assigns.conversation_id,
          sender_id: socket.assigns.user_id
        }
        |> maybe_add_parent_id(parent_message_id)

      case Chat.create_message(attrs) do
        {:ok, message} ->
          message = maybe_link_attachments(message, params)

          # Use cached participant_ids (kept in sync via PubSub invalidation
          # from :participants_changed handler). Saves 1 DB query per message.
          participant_ids = socket.assigns.participant_ids
          append_dm_urgent_events(message, socket.assigns.user_id, participant_ids)

          broadcast!(
            socket,
            "new_message",
            encrypted_message_payload(
              message,
              :conversation_id,
              if(client_nonce, do: %{client_nonce: client_nonce}, else: %{})
            )
          )

          notify_scope_mutation(
            participant_ids,
            "dm",
            socket.assigns.conversation_id
          )

          conversation_id = socket.assigns.conversation_id
          sender_id = socket.assigns.user_id
          sender_info = socket.assigns.sender_info

          # Combined per-user broadcast: merges dm_message notification +
          # scope_summary_updated into a single WS event per participant.
          # Client handles both unread increment and sidebar update from this.
          notify_dm_activity(
            conversation_id,
            sender_id,
            participant_ids,
            sender_info,
            message
          )

          # Push notifications for offline DM participants
          Vesper.Notifications.notify_dm_message(
            sender_id,
            conversation_id,
            participant_ids
          )

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
  end

  # Encrypted reactions
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
           :conversation_id,
           socket.assigns.conversation_id,
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
            "dm",
            socket.assigns.conversation_id,
            socket.assigns.user_id,
            "reaction_update",
            payload
          )
          |> case do
            {:ok, event} -> event.room_seq
            _ -> nil
          end

        broadcast!(socket, "reaction_update", Map.put(payload, :room_seq, room_seq))

        notify_scope_mutation(
          socket.assigns.participant_ids,
          "dm",
          socket.assigns.conversation_id
        )

        {:reply, :ok, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  # Plaintext fallback
  def handle_in("add_reaction", %{"message_id" => message_id, "emoji" => emoji}, socket) do
    case handle_reaction(
           :add,
           message_id,
           emoji,
           socket.assigns.user_id,
           :conversation_id,
           socket.assigns.conversation_id
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
            "dm",
            socket.assigns.conversation_id,
            socket.assigns.user_id,
            "reaction_update",
            payload
          )
          |> case do
            {:ok, event} -> event.room_seq
            _ -> nil
          end

        broadcast!(socket, "reaction_update", Map.put(payload, :room_seq, room_seq))

        notify_scope_mutation(
          socket.assigns.participant_ids,
          "dm",
          socket.assigns.conversation_id
        )

        {:reply, :ok, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  # Encrypted remove
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
           :conversation_id,
           socket.assigns.conversation_id,
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
            "dm",
            socket.assigns.conversation_id,
            socket.assigns.user_id,
            "reaction_update",
            payload
          )
          |> case do
            {:ok, event} -> event.room_seq
            _ -> nil
          end

        broadcast!(socket, "reaction_update", Map.put(payload, :room_seq, room_seq))

        notify_scope_mutation(
          socket.assigns.participant_ids,
          "dm",
          socket.assigns.conversation_id
        )

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
           :conversation_id,
           socket.assigns.conversation_id
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
            "dm",
            socket.assigns.conversation_id,
            socket.assigns.user_id,
            "reaction_update",
            payload
          )
          |> case do
            {:ok, event} -> event.room_seq
            _ -> nil
          end

        broadcast!(socket, "reaction_update", Map.put(payload, :room_seq, room_seq))

        notify_scope_mutation(
          socket.assigns.participant_ids,
          "dm",
          socket.assigns.conversation_id
        )

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
            "dm",
            socket.assigns.conversation_id,
            socket.assigns.user_id,
            "message_edited",
            payload
          )
          |> case do
            {:ok, event} -> event.room_seq
            _ -> nil
          end

        broadcast!(socket, "message_edited", Map.put(payload, :room_seq, room_seq))

        notify_scope_mutation(
          socket.assigns.participant_ids,
          "dm",
          socket.assigns.conversation_id
        )

        {:reply, :ok, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  def handle_in("delete_message", %{"message_id" => id}, socket) do
    case handle_delete_message(id, socket.assigns.user_id) do
      {:ok, _deleted_message} ->
        latest_message = Chat.get_latest_conversation_message(socket.assigns.conversation_id)

        payload = %{
          message_id: id,
          conversation_id: socket.assigns.conversation_id,
          latest_message: activity_message_json(latest_message)
        }

        room_seq =
          Runtime.append_scope_event(
            "dm",
            socket.assigns.conversation_id,
            socket.assigns.user_id,
            "message_deleted",
            payload
          )
          |> case do
            {:ok, event} -> event.room_seq
            _ -> nil
          end

        broadcast!(socket, "message_deleted", Map.put(payload, :room_seq, room_seq))

        notify_scope_mutation(
          socket.assigns.participant_ids,
          "dm",
          socket.assigns.conversation_id
        )

        ScopeSummary.broadcast_dm_update(
          socket.assigns.conversation_id,
          latest_message,
          socket.assigns.participant_ids
        )

        {:reply, :ok, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  def handle_in("set_disappearing", %{"ttl" => ttl}, socket) do
    conversation_id = socket.assigns.conversation_id
    parsed_ttl = if is_integer(ttl) and ttl > 0, do: ttl, else: nil

    case Chat.update_conversation_ttl(conversation_id, parsed_ttl) do
      {:ok, _} ->
        broadcast!(socket, "disappearing_ttl_updated", %{
          conversation_id: conversation_id,
          disappearing_ttl: parsed_ttl
        })

        {:reply, :ok, socket}

      {:error, _} ->
        {:reply, {:error, %{reason: "could not update TTL"}}, socket}
    end
  end

  def handle_in("typing_start", _payload, socket) do
    broadcast_from!(socket, "typing_start", typing_start_payload(socket))
    broadcast_dm_typing(socket, "dm_typing_start", typing_start_payload(socket))
    {:noreply, socket}
  end

  def handle_in("typing_stop", _payload, socket) do
    broadcast_from!(socket, "typing_stop", %{user_id: socket.assigns.user_id})
    broadcast_dm_typing(socket, "dm_typing_stop", %{user_id: socket.assigns.user_id})
    {:noreply, socket}
  end

  def handle_in("call_reject", _payload, socket) do
    conversation_id = socket.assigns.conversation_id
    user_id = socket.assigns.user_id

    Voice.call_reject(conversation_id, user_id)

    broadcast!(socket, "call_rejected", %{
      conversation_id: conversation_id,
      user_id: user_id
    })

    VesperWeb.Endpoint.broadcast("voice:dm:#{conversation_id}", "call_rejected", %{
      conversation_id: conversation_id,
      user_id: user_id
    })

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
        socket.assigns.conversation_id,
        socket.assigns.user_id,
        "dm:#{socket.assigns.conversation_id}"
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
  def handle_info(:replay_mls_join_broadcasts, socket) do
    MlsHandler.replay_mls_join_broadcasts(socket, socket.assigns.conversation_id)
    {:noreply, socket}
  end

  def handle_info({:participants_changed, new_participant_ids}, socket) do
    user_id = socket.assigns.user_id

    if user_id not in new_participant_ids do
      # Current user was removed from the conversation — disconnect
      {:stop, {:shutdown, :removed_from_conversation}, socket}
    else
      {:noreply, assign(socket, :participant_ids, new_participant_ids)}
    end
  end

  def handle_info(_msg, socket), do: {:noreply, socket}

  defp notify_dm_activity(conversation_id, sender_id, participant_ids, sender_info, message) do
    payload = %{
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
      VesperWeb.Endpoint.broadcast("user:#{uid}", "dm_activity", payload)
    end
  end

  defp notify_scope_mutation(participant_ids, kind, scope_id) when is_list(participant_ids) do
    VesperWeb.Endpoint.broadcast("scope:dm:#{scope_id}", "scope_mutation", %{
      kind: kind,
      scope_id: scope_id
    })

    :ok
  end

  defp notify_history_request_pending(conversation_id, _requester_id, topic) do
    for user_id <- Chat.list_participant_ids(conversation_id) do
      VesperWeb.Endpoint.broadcast("user:#{user_id}", "mls_history_request_pending", %{
        scope_id: conversation_id,
        topic: topic
      })
    end

    :ok
  end

  defp append_dm_urgent_events(message, sender_id, participant_ids)
       when is_list(participant_ids) do
    urgent_events =
      participant_ids
      |> Enum.reject(&(&1 == sender_id))
      |> Enum.map(fn user_id ->
        %{
          user_id: user_id,
          scope_kind: "dm",
          scope_id: message.conversation_id,
          payload: %{
            message_id: message.id,
            room_seq: message.room_seq,
            sender_id: message.sender_id,
            sender: sender_json(message.sender),
            parent_message_id: message.parent_message_id,
            urgent_reason: "dm",
            mentions_you: false,
            reply_to_you: false,
            is_dm: true
          }
        }
      end)

    Sync.append_urgent_events(urgent_events)
  end

  defp broadcast_dm_typing(socket, event, payload) do
    conversation_id = socket.assigns.conversation_id

    for participant_id <- socket.assigns.participant_ids,
        participant_id != socket.assigns.user_id do
      VesperWeb.Endpoint.broadcast("user:#{participant_id}", event, %{
        conversation_id: conversation_id,
        payload: payload
      })
    end
  end
end
