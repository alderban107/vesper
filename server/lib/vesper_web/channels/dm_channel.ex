defmodule VesperWeb.DmChannel do
  use Phoenix.Channel
  import Ecto.Query

  alias Vesper.Chat
  alias Vesper.Accounts
  alias Vesper.Encryption

  @impl true
  def join("dm:" <> conversation_id, _payload, socket) do
    # Verify user is a participant in this conversation
    user_id = socket.assigns.user_id

    participant =
      Vesper.Repo.get_by(Vesper.Chat.DmParticipant,
        conversation_id: conversation_id,
        user_id: user_id
      )

    if participant do
      socket = assign(socket, :conversation_id, conversation_id)
      {:ok, socket}
    else
      {:error, %{reason: "not a participant"}}
    end
  end

  @impl true
  # Encrypted message
  def handle_in("new_message", %{"ciphertext" => ciphertext, "mls_epoch" => epoch} = params, socket) do
    attrs = %{
      ciphertext: Base.decode64!(ciphertext),
      mls_epoch: epoch,
      conversation_id: socket.assigns.conversation_id,
      sender_id: socket.assigns.user_id
    }

    attrs = maybe_add_parent(attrs, params)

    case Chat.create_message(attrs) do
      {:ok, message} ->
        message = maybe_link_attachments(message, params)
        broadcast!(socket, "new_message", encrypted_message_payload(message))
        notify_participants(socket.assigns.conversation_id, socket.assigns.user_id, message)
        {:reply, :ok, socket}

      {:error, _changeset} ->
        {:reply, {:error, %{reason: "could not send message"}}, socket}
    end
  end

  def handle_in("add_reaction", %{"message_id" => message_id, "emoji" => emoji}, socket) do
    case Chat.add_reaction(%{
      message_id: message_id,
      sender_id: socket.assigns.user_id,
      emoji: emoji
    }) do
      {:ok, _reaction} ->
        broadcast!(socket, "reaction_update", %{
          action: "add",
          message_id: message_id,
          emoji: emoji,
          sender_id: socket.assigns.user_id
        })
        {:reply, :ok, socket}

      {:error, _} ->
        {:reply, {:error, %{reason: "could not add reaction"}}, socket}
    end
  end

  def handle_in("remove_reaction", %{"message_id" => message_id, "emoji" => emoji}, socket) do
    case Chat.remove_reaction(message_id, socket.assigns.user_id, emoji) do
      {:ok, _} ->
        broadcast!(socket, "reaction_update", %{
          action: "remove",
          message_id: message_id,
          emoji: emoji,
          sender_id: socket.assigns.user_id
        })
        {:reply, :ok, socket}

      {:error, _} ->
        {:reply, {:error, %{reason: "could not remove reaction"}}, socket}
    end
  end

  # Edit message (encrypted)
  def handle_in("edit_message", %{"message_id" => id, "ciphertext" => ciphertext, "mls_epoch" => epoch}, socket) do
    case Chat.get_message(id) do
      nil ->
        {:reply, {:error, %{reason: "message not found"}}, socket}

      message ->
        if message.sender_id != socket.assigns.user_id do
          {:reply, {:error, %{reason: "not the message author"}}, socket}
        else
          now = DateTime.utc_now() |> DateTime.truncate(:second)

          case Chat.update_message(message, %{
            ciphertext: Base.decode64!(ciphertext),
            mls_epoch: epoch,
            edited_at: now
          }) do
            {:ok, _updated} ->
              broadcast!(socket, "message_edited", %{
                message_id: id,
                ciphertext: ciphertext,
                mls_epoch: epoch,
                edited_at: now
              })
              {:reply, :ok, socket}

            {:error, _} ->
              {:reply, {:error, %{reason: "could not edit message"}}, socket}
          end
        end
    end
  end

  # Delete message
  def handle_in("delete_message", %{"message_id" => id}, socket) do
    case Chat.get_message(id) do
      nil ->
        {:reply, {:error, %{reason: "message not found"}}, socket}

      message ->
        if message.sender_id != socket.assigns.user_id do
          {:reply, {:error, %{reason: "not the message author"}}, socket}
        else
          case Chat.delete_message(message) do
            {:ok, _} ->
              broadcast!(socket, "message_deleted", %{message_id: id})
              {:reply, :ok, socket}

            {:error, _} ->
              {:reply, {:error, %{reason: "could not delete message"}}, socket}
          end
        end
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
    user = Accounts.get_user(socket.assigns.user_id)

    broadcast_from!(socket, "typing_start", %{
      user_id: socket.assigns.user_id,
      username: user && user.username
    })

    {:noreply, socket}
  end

  def handle_in("typing_stop", _payload, socket) do
    broadcast_from!(socket, "typing_stop", %{
      user_id: socket.assigns.user_id
    })

    {:noreply, socket}
  end

  # MLS: Request to join the group
  def handle_in("mls_request_join", _payload, socket) do
    broadcast_from!(socket, "mls_request_join", %{
      user_id: socket.assigns.user_id
    })

    {:noreply, socket}
  end

  # MLS: Commit message (Add/Remove/Update)
  def handle_in("mls_commit", %{"commit_data" => commit_data}, socket) do
    broadcast!(socket, "mls_commit", %{
      commit_data: commit_data,
      sender_id: socket.assigns.user_id
    })

    {:noreply, socket}
  end

  # MLS: Remove a member from the group
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

  # MLS: Welcome message for a specific recipient
  def handle_in(
        "mls_welcome",
        %{"recipient_id" => recipient_id, "welcome_data" => welcome_data},
        socket
      ) do
    conversation_id = socket.assigns.conversation_id
    sender_id = socket.assigns.user_id

    # Broadcast to conversation (recipient filters client-side)
    broadcast!(socket, "mls_welcome", %{
      recipient_id: recipient_id,
      welcome_data: welcome_data,
      sender_id: sender_id
    })

    # Also store for offline delivery
    Encryption.store_pending_welcome(%{
      recipient_id: recipient_id,
      conversation_id: conversation_id,
      welcome_data: Base.decode64!(welcome_data),
      sender_id: sender_id
    })

    {:noreply, socket}
  end

  # Notify all participants of a new DM message via their user channel.
  # This ensures recipients who haven't opened the conversation yet still see it.
  defp notify_participants(conversation_id, sender_id, message) do
    participant_ids =
      Vesper.Repo.all(
        from(p in Vesper.Chat.DmParticipant,
          where: p.conversation_id == ^conversation_id,
          select: p.user_id
        )
      )

    sender = Accounts.get_user(sender_id)

    notification = %{
      conversation_id: conversation_id,
      message_id: message.id,
      sender_id: sender_id,
      sender: if(sender, do: %{
        id: sender.id,
        username: sender.username,
        display_name: sender.display_name
      }),
      preview: message.content && String.slice(message.content, 0, 100),
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

  defp maybe_add_parent(attrs, %{"parent_message_id" => parent_id}) when is_binary(parent_id) do
    Map.put(attrs, :parent_message_id, parent_id)
  end

  defp maybe_add_parent(attrs, _params), do: attrs

  defp maybe_link_attachments(message, %{"attachment_ids" => ids}) when is_list(ids) and ids != [] do
    Chat.link_attachments_to_message(ids, message.id)
    Vesper.Repo.preload(message, :attachments, force: true)
  end

  defp maybe_link_attachments(message, _params), do: message

  defp encrypted_message_payload(message) do
    %{
      id: message.id,
      ciphertext: Base.encode64(message.ciphertext),
      mls_epoch: message.mls_epoch,
      conversation_id: message.conversation_id,
      sender_id: message.sender_id,
      sender: sender_json(message.sender),
      expires_at: message.expires_at,
      parent_message_id: message.parent_message_id,
      inserted_at: message.inserted_at,
      attachments: attachments_json(message)
    }
  end

  defp sender_json(nil), do: nil

  defp sender_json(sender) do
    %{
      id: sender.id,
      username: sender.username,
      display_name: sender.display_name,
      avatar_url: sender.avatar_url
    }
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
end
