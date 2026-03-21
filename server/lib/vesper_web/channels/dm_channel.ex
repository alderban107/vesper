defmodule VesperWeb.DmChannel do
  use Phoenix.Channel

  alias Vesper.Chat
  alias Vesper.Encryption
  alias Vesper.Runtime
  alias Vesper.Sync
  alias Vesper.Voice
  alias VesperWeb.ScopeSummary
  alias Vesper.Workers.ProcessPendingCryptoEvictions
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

  def handle_in("mls_request_join", payload, socket) when is_map(payload) do
    broadcast_from!(socket, "mls_request_join", %{
      user_id: socket.assigns.user_id,
      username: socket.assigns.username,
      device_id: Map.get(payload, "device_id") || socket.assigns.device_client_id
    })

    {:noreply, socket}
  end

  def handle_in("mls_request_join_all", _payload, socket) do
    broadcast_from!(socket, "mls_request_join_all", %{user_id: socket.assigns.user_id})
    {:noreply, socket}
  end

  def handle_in("mls_resync_request", payload, socket) when is_map(payload) do
    case normalize_resync_request(payload) do
      {:ok, attrs} ->
        conversation_id = socket.assigns.conversation_id

        case Encryption.store_pending_resync_request(%{
               group_id: conversation_id,
               request_id: attrs.request_id,
               requester_id: socket.assigns.user_id,
               requester_username: socket.assigns.username,
               requester_client_id:
                 Map.get(payload, "device_id") || socket.assigns.device_client_id,
               last_known_epoch: attrs.last_known_epoch,
               reason: attrs.reason,
               conversation_id: conversation_id
             }) do
          {:ok, request} ->
            broadcast_from!(socket, "mls_resync_request", %{
              id: request.id,
              user_id: socket.assigns.user_id,
              username: socket.assigns.username,
              device_id: request.requester_client_id,
              request_id: request.request_id,
              last_known_epoch: request.last_known_epoch,
              reason: request.reason
            })

            {:noreply, socket}

          {:error, _changeset} ->
            {:reply, {:error, %{reason: "could not store resync request"}}, socket}
        end

      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  def handle_in("mls_commit", %{"commit_data" => commit_data}, socket)
      when is_binary(commit_data) do
    case Encryption.store_mls_event(%{
           group_id: socket.assigns.conversation_id,
           conversation_id: socket.assigns.conversation_id,
           event_type: "mls_commit",
           payload: %{commit_data: commit_data},
           sender_id: socket.assigns.user_id,
           sender_device_id: socket.assigns.device_client_id
         }) do
      {:ok, event} ->
        broadcast!(socket, "mls_commit", %{
          seq: event.id,
          commit_data: commit_data,
          sender_id: socket.assigns.user_id,
          sender_device_id: socket.assigns.device_client_id
        })

        {:noreply, socket}

      {:error, _changeset} ->
        {:reply, {:error, %{reason: "could not store commit"}}, socket}
    end
  end

  def handle_in("mls_eviction_claim", %{"id" => eviction_id}, socket)
      when is_binary(eviction_id) do
    with :ok <- ensure_trusted_sponsor(socket),
         {:ok, _eviction} <-
           Encryption.claim_pending_crypto_eviction(
             eviction_id,
             "dm",
             socket.assigns.conversation_id,
             socket.assigns.user_id,
             socket.assigns.device_client_id
           ) do
      {:reply, :ok, socket}
    else
      {:error, reason} ->
        {:reply, {:error, %{reason: eviction_error_reason(reason)}}, socket}
    end
  end

  def handle_in("mls_eviction_skip", %{"id" => eviction_id} = payload, socket)
      when is_binary(eviction_id) do
    target_user_id =
      Map.get(payload, "target_user_id") ||
        Map.get(payload, "removed_user_id") ||
        Map.get(payload, "user_id")

    target_device_id =
      optional_binary(
        Map.get(payload, "target_device_id") ||
          Map.get(payload, "removed_device_id") ||
          Map.get(payload, "device_id")
      )

    reason = optional_binary(Map.get(payload, "reason")) || "skipped"

    with :ok <- ensure_trusted_sponsor(socket),
         true <- is_binary(target_user_id),
         {:ok, _eviction} <-
           Encryption.skip_pending_crypto_eviction(
             eviction_id,
             "dm",
             socket.assigns.conversation_id,
             target_user_id,
             target_device_id,
             socket.assigns.user_id,
             socket.assigns.device_client_id,
             reason
           ) do
      request_next_crypto_eviction("dm", socket.assigns.conversation_id)
      {:reply, :ok, socket}
    else
      false ->
        {:reply, {:error, %{reason: "missing target_user_id"}}, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: eviction_error_reason(reason)}}, socket}
    end
  end

  def handle_in(
        "mls_remove",
        %{"removed_user_id" => removed_user_id, "commit_data" => commit_data} = payload,
        socket
      )
      when is_binary(removed_user_id) and is_binary(commit_data) do
    removed_device_id = optional_binary(Map.get(payload, "removed_device_id"))
    eviction_id = optional_binary(Map.get(payload, "eviction_id"))

    event_payload =
      %{
        removed_user_id: removed_user_id,
        commit_data: commit_data
      }
      |> maybe_put(:removed_device_id, removed_device_id)
      |> maybe_put(:eviction_id, eviction_id)

    crypto_eviction =
      if eviction_id do
        %{
          eviction_id: eviction_id,
          scope_kind: "dm",
          scope_id: socket.assigns.conversation_id,
          removed_user_id: removed_user_id,
          removed_device_id: removed_device_id,
          sponsor_user_id: socket.assigns.user_id,
          sponsor_device_id: socket.assigns.device_client_id
        }
      end

    case Encryption.store_mls_remove_event(
           %{
             group_id: socket.assigns.conversation_id,
             conversation_id: socket.assigns.conversation_id,
             event_type: "mls_remove",
             payload: event_payload,
             sender_id: socket.assigns.user_id,
             sender_device_id: socket.assigns.device_client_id
           },
           crypto_eviction
         ) do
      {:ok, event} ->
        broadcast!(
          socket,
          "mls_remove",
          %{
            seq: event.id,
            removed_user_id: removed_user_id,
            commit_data: commit_data,
            sender_id: socket.assigns.user_id,
            sender_device_id: socket.assigns.device_client_id
          }
          |> maybe_put(:removed_device_id, removed_device_id)
          |> maybe_put(:eviction_id, eviction_id)
        )

        if eviction_id do
          request_next_crypto_eviction("dm", socket.assigns.conversation_id)
        end

        {:noreply, socket}

      {:error, reason} when is_atom(reason) ->
        {:reply, {:error, %{reason: eviction_error_reason(reason)}}, socket}

      {:error, _changeset} ->
        {:reply, {:error, %{reason: "could not store remove"}}, socket}
    end
  end

  def handle_in(
        "mls_welcome",
        %{"recipient_id" => recipient_id, "welcome_data" => welcome_data} = payload,
        socket
      )
      when is_binary(recipient_id) and is_binary(welcome_data) do
    case safe_decode64(welcome_data) do
      {:ok, decoded} ->
        conversation_id = socket.assigns.conversation_id
        sender_id = socket.assigns.user_id

        case Encryption.store_pending_welcome(%{
               recipient_id: recipient_id,
               recipient_client_id: Map.get(payload, "recipient_device_id"),
               recipient_key_package_ref: Map.get(payload, "key_package_ref"),
               conversation_id: conversation_id,
               group_id: conversation_id,
               welcome_data: decoded,
               sender_id: sender_id
             }) do
          {:ok, welcome} ->
            broadcast!(socket, "mls_welcome", %{
              id: welcome.id,
              recipient_id: recipient_id,
              recipient_device_id: welcome.recipient_client_id,
              key_package_ref: welcome.recipient_key_package_ref,
              welcome_data: welcome_data,
              sender_id: sender_id
            })

            {:noreply, socket}

          {:error, _changeset} ->
            {:reply, {:error, %{reason: "could not store welcome"}}, socket}
        end

      {:error, _} ->
        {:reply, {:error, %{reason: "invalid encoding"}}, socket}
    end
  end

  def handle_in("mls_history_request", payload, socket) do
    requester_device_id =
      case Map.get(payload, "device_id") do
        value when is_binary(value) and value != "" -> value
        _ -> nil
      end

    case Encryption.store_pending_history_request(%{
           group_id: socket.assigns.conversation_id,
           requester_id: socket.assigns.user_id,
           requester_username: socket.assigns.username,
           requester_client_id: requester_device_id,
           conversation_id: socket.assigns.conversation_id
         }) do
      {:ok, request} ->
        broadcast_from!(socket, "mls_history_request", %{
          id: request.id,
          user_id: socket.assigns.user_id,
          device_id: requester_device_id
        })

        notify_history_request_pending(
          socket.assigns.conversation_id,
          socket.assigns.user_id,
          "dm:#{socket.assigns.conversation_id}"
        )

        {:noreply, socket}

      {:error, _changeset} ->
        {:reply, {:error, %{reason: "could not store history request"}}, socket}
    end
  end

  def handle_in(
        "mls_history_bundle",
        %{
          "ciphertext" => ciphertext,
          "mls_epoch" => epoch,
          "recipient_id" => recipient_id
        } = payload,
        socket
      ) do
    recipient_device_id =
      case Map.get(payload, "recipient_device_id") do
        value when is_binary(value) and value != "" -> value
        _ -> nil
      end

    case Encryption.store_pending_history_bundle(%{
           group_id: socket.assigns.conversation_id,
           ciphertext: ciphertext,
           mls_epoch: epoch,
           recipient_id: recipient_id,
           recipient_client_id: recipient_device_id,
           sender_id: socket.assigns.user_id,
           conversation_id: socket.assigns.conversation_id
         }) do
      {:ok, bundle} ->
        broadcast!(socket, "mls_history_bundle", %{
          id: bundle.id,
          ciphertext: ciphertext,
          mls_epoch: epoch,
          recipient_id: recipient_id,
          recipient_device_id: recipient_device_id,
          sender_id: socket.assigns.user_id
        })

        VesperWeb.Endpoint.broadcast("user:#{recipient_id}", "mls_history_bundle_pending", %{
          scope_id: socket.assigns.conversation_id,
          topic: "dm:#{socket.assigns.conversation_id}"
        })

        {:noreply, socket}

      {:error, _changeset} ->
        {:reply, {:error, %{reason: "could not store history bundle"}}, socket}
    end
  end

  def handle_in(_event, _payload, socket),
    do: {:reply, {:error, %{reason: "unrecognized event"}}, socket}

  defp normalize_resync_request(payload) do
    request_id = Map.get(payload, "request_id")
    last_known_epoch = Map.get(payload, "last_known_epoch")
    reason = Map.get(payload, "reason")

    cond do
      not is_binary(request_id) ->
        {:error, "missing request_id"}

      not (is_nil(last_known_epoch) or is_integer(last_known_epoch)) ->
        {:error, "invalid last_known_epoch"}

      not (is_nil(reason) or is_binary(reason)) ->
        {:error, "invalid reason"}

      true ->
        {:ok,
         %{
           request_id: request_id,
           last_known_epoch: last_known_epoch,
           reason: reason
         }}
    end
  end

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

  defp notify_scope_mutation(participant_ids, kind, scope_id) when is_list(participant_ids) do
    VesperWeb.Endpoint.broadcast("scope:dm:#{scope_id}", "scope_mutation", %{
      kind: kind,
      scope_id: scope_id
    })

    :ok
  end

  defp notify_history_request_pending(conversation_id, requester_id, topic) do
    for user_id <- Chat.list_participant_ids(conversation_id), user_id != requester_id do
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

  defp ensure_trusted_sponsor(socket) do
    if socket.assigns.device_trust_state == "trusted" do
      :ok
    else
      {:error, :trusted_device_required}
    end
  end

  defp request_next_crypto_eviction(scope_kind, scope_id) do
    ProcessPendingCryptoEvictions.request_scope(scope_kind, scope_id)
  end

  defp optional_binary(value) when is_binary(value) and value != "", do: value
  defp optional_binary(_value), do: nil

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp eviction_error_reason(:trusted_device_required), do: "trusted device required"
  defp eviction_error_reason(:not_found), do: "eviction not found"
  defp eviction_error_reason(:not_claimable), do: "eviction not claimable"
  defp eviction_error_reason(:target_cannot_sponsor), do: "target cannot sponsor eviction"
  defp eviction_error_reason(:target_mismatch), do: "eviction target mismatch"
  defp eviction_error_reason(:target_device_mismatch), do: "eviction target device mismatch"
  defp eviction_error_reason(:sponsor_mismatch), do: "eviction sponsor mismatch"
  defp eviction_error_reason(reason) when is_binary(reason), do: reason
  defp eviction_error_reason(reason), do: inspect(reason)
end
