defmodule VesperWeb.DmChannel do
  use Phoenix.Channel

  alias Vesper.Chat
  alias Vesper.Encryption
  alias Vesper.Voice
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

          broadcast!(
            socket,
            "new_message",
            encrypted_message_payload(message, :conversation_id)
          )

          # Run notifications async to avoid blocking the channel process
          conversation_id = socket.assigns.conversation_id
          sender_id = socket.assigns.user_id
          participant_ids = socket.assigns.participant_ids
          sender_info = socket.assigns.sender_info

          Task.Supervisor.start_child(Vesper.NotificationSupervisor, fn ->
            notify_participants(
              conversation_id,
              sender_id,
              participant_ids,
              sender_info,
              message
            )
          end)

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
  def handle_in("add_reaction", %{"message_id" => message_id, "ciphertext" => ciphertext} = payload, socket) do
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
        broadcast!(socket, "reaction_update", %{
          action: "add",
          message_id: message_id,
          ciphertext: ciphertext,
          mls_epoch: mls_epoch,
          sender_id: socket.assigns.user_id
        })

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

  # Encrypted remove
  def handle_in("remove_reaction", %{"message_id" => message_id, "ciphertext" => ciphertext} = payload, socket) do
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
        broadcast!(socket, "reaction_update", %{
          action: "remove",
          message_id: message_id,
          ciphertext: ciphertext,
          mls_epoch: mls_epoch,
          sender_id: socket.assigns.user_id
        })

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
    {:noreply, socket}
  end

  def handle_in("typing_stop", _payload, socket) do
    broadcast_from!(socket, "typing_stop", %{user_id: socket.assigns.user_id})
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

  def handle_in("mls_request_join", _payload, socket) do
    broadcast_from!(socket, "mls_request_join", %{user_id: socket.assigns.user_id})
    {:noreply, socket}
  end

  def handle_in("mls_commit", %{"commit_data" => commit_data}, socket)
      when is_binary(commit_data) do
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
      )
      when is_binary(removed_user_id) and is_binary(commit_data) do
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
      )
      when is_binary(recipient_id) and is_binary(welcome_data) do
    case safe_decode64(welcome_data) do
      {:ok, decoded} ->
        conversation_id = socket.assigns.conversation_id
        sender_id = socket.assigns.user_id

        broadcast!(socket, "mls_welcome", %{
          recipient_id: recipient_id,
          welcome_data: welcome_data,
          sender_id: sender_id
        })

        Encryption.store_pending_welcome(%{
          recipient_id: recipient_id,
          conversation_id: conversation_id,
          welcome_data: decoded,
          sender_id: sender_id
        })

        {:noreply, socket}

      {:error, _} ->
        {:reply, {:error, %{reason: "invalid encoding"}}, socket}
    end
  end

  def handle_in(_event, _payload, socket),
    do: {:reply, {:error, %{reason: "unrecognized event"}}, socket}

  defp notify_participants(conversation_id, sender_id, participant_ids, sender_info, message) do
    notification = %{
      conversation_id: conversation_id,
      message_id: message.id,
      sender_id: sender_id,
      sender: sender_info,
      inserted_at: message.inserted_at
    }

    for uid <- participant_ids, uid != sender_id do
      VesperWeb.Endpoint.broadcast("user:#{uid}", "dm_message", notification)

      VesperWeb.Endpoint.broadcast("user:#{uid}", "dm_unread_update", %{
        conversation_id: conversation_id,
        message_id: message.id
      })
    end
  end
end
