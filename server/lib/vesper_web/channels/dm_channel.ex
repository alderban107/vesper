defmodule VesperWeb.DmChannel do
  use Phoenix.Channel

  alias Vesper.Chat
  alias Vesper.Runtime
  alias Vesper.Sync
  alias Vesper.Voice
  alias VesperWeb.ScopeSummary
  import VesperWeb.ChannelHelpers

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

      socket =
        socket
        |> assign(:conversation_id, conversation_id)
        |> assign(:participant_ids, participant_ids)
        |> assign(:sender_info, sender_info)


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
          mls_epoch: epoch,
          conversation_id: socket.assigns.conversation_id,
          sender_id: socket.assigns.user_id
        }
        |> maybe_add_parent_id(parent_message_id)

      case Chat.create_message(attrs) do
        {:ok, message} ->
          message = maybe_link_attachments(message, params)
          append_dm_urgent_events(message, socket.assigns.user_id, socket.assigns.participant_ids)

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
            socket.assigns.participant_ids,
            "dm",
            socket.assigns.conversation_id
          )

          conversation_id = socket.assigns.conversation_id
          sender_id = socket.assigns.user_id
          participant_ids = socket.assigns.participant_ids
          sender_info = socket.assigns.sender_info

          notify_participants(
            conversation_id,
            sender_id,
            participant_ids,
            sender_info,
            message
          )

          ScopeSummary.broadcast_dm_update(conversation_id, message, participant_ids)

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

  def handle_in(_event, _payload, socket),
    do: {:reply, {:error, %{reason: "unrecognized event"}}, socket}

  @impl true

end
