defmodule VesperWeb.ChatChannel do
  use Phoenix.Channel

  alias Vesper.Servers
  alias Vesper.Servers.{MemberCache, Permissions, PermissionsCache}
  alias Vesper.Chat
  alias Vesper.Encryption
  alias Vesper.Runtime
  alias Vesper.Sync
  alias VesperWeb.ScopeSummary
  alias Vesper.Workers.ProcessPendingCryptoEvictions
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
    role = Servers.user_role(user_id, server_id)

    if role in ~w(owner admin) do
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
        channel_id = socket.assigns.channel_id

        case Encryption.store_pending_resync_request(%{
               group_id: channel_id,
               request_id: attrs.request_id,
               requester_id: socket.assigns.user_id,
               requester_username: socket.assigns.username,
               requester_client_id:
                 Map.get(payload, "device_id") || socket.assigns.device_client_id,
               last_known_epoch: attrs.last_known_epoch,
               reason: attrs.reason,
               channel_id: channel_id
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
           group_id: socket.assigns.channel_id,
           channel_id: socket.assigns.channel_id,
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
             "channel",
             socket.assigns.channel_id,
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
             "channel",
             socket.assigns.channel_id,
             target_user_id,
             target_device_id,
             socket.assigns.user_id,
             socket.assigns.device_client_id,
             reason
           ) do
      request_next_crypto_eviction("channel", socket.assigns.channel_id)
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

    case Encryption.store_mls_event(%{
           group_id: socket.assigns.channel_id,
           channel_id: socket.assigns.channel_id,
           event_type: "mls_remove",
           payload: event_payload,
           sender_id: socket.assigns.user_id,
           sender_device_id: socket.assigns.device_client_id
         }) do
      {:ok, event} ->
        case maybe_complete_crypto_eviction(
               eviction_id,
               "channel",
               socket.assigns.channel_id,
               removed_user_id,
               removed_device_id,
               event.id,
               socket.assigns.user_id,
               socket.assigns.device_client_id
             ) do
          :ok ->
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
              request_next_crypto_eviction("channel", socket.assigns.channel_id)
            end

            {:noreply, socket}

          {:error, reason} ->
            {:reply, {:error, %{reason: eviction_error_reason(reason)}}, socket}
        end

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
        channel_id = socket.assigns.channel_id
        sender_id = socket.assigns.user_id

        case Encryption.store_pending_welcome(%{
               recipient_id: recipient_id,
               recipient_client_id: Map.get(payload, "recipient_device_id"),
               recipient_key_package_ref: Map.get(payload, "key_package_ref"),
               channel_id: channel_id,
               group_id: channel_id,
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
           group_id: socket.assigns.channel_id,
           requester_id: socket.assigns.user_id,
           requester_username: socket.assigns.username,
           requester_client_id: requester_device_id,
           channel_id: socket.assigns.channel_id
         }) do
      {:ok, request} ->
        broadcast_from!(socket, "mls_history_request", %{
          id: request.id,
          user_id: socket.assigns.user_id,
          device_id: requester_device_id
        })

        notify_history_request_pending(
          socket.assigns.server_id,
          socket.assigns.channel_id,
          socket.assigns.user_id,
          "chat:channel:#{socket.assigns.channel_id}"
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
           group_id: socket.assigns.channel_id,
           ciphertext: ciphertext,
           mls_epoch: epoch,
           recipient_id: recipient_id,
           recipient_client_id: recipient_device_id,
           sender_id: socket.assigns.user_id,
           channel_id: socket.assigns.channel_id
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
          scope_id: socket.assigns.channel_id,
          topic: "chat:channel:#{socket.assigns.channel_id}"
        })

        {:noreply, socket}

      {:error, _changeset} ->
        {:reply, {:error, %{reason: "could not store history bundle"}}, socket}
    end
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

  defp notify_unread(channel_id, message, sender_id, member_ids) do
    recipients = MapSet.delete(member_ids, sender_id)

    :telemetry.execute(
      [:vesper, :chat, :notification, :fanout],
      %{count: MapSet.size(recipients)},
      %{channel_id: channel_id, type: :unread}
    )

    for uid <- recipients do
      VesperWeb.Endpoint.broadcast("user:#{uid}", "unread_update", %{
        channel_id: channel_id,
        message_id: message.id,
        inserted_at: message.inserted_at,
        sender_id: message.sender_id,
        sender: sender_json(message.sender)
      })
    end
  end

  defp notify_scope_mutation(server_id, kind, scope_id) do
    VesperWeb.Endpoint.broadcast("presence:server:#{server_id}", "scope_mutation", %{
      kind: kind,
      scope_id: scope_id
    })

    :ok
  end

  defp notify_history_request_pending(server_id, channel_id, requester_id, topic) do
    server_id
    |> Servers.list_member_ids()
    |> Enum.reject(&(&1 == requester_id))
    |> Enum.filter(&Servers.user_can_view_channel?(&1, channel_id))
    |> Enum.each(fn user_id ->
      VesperWeb.Endpoint.broadcast("user:#{user_id}", "mls_history_request_pending", %{
        scope_id: channel_id,
        topic: topic
      })
    end)

    :ok
  end

  defp ensure_trusted_sponsor(socket) do
    if socket.assigns.device_trust_state == "trusted" do
      :ok
    else
      {:error, :trusted_device_required}
    end
  end

  defp maybe_complete_crypto_eviction(
         nil,
         _scope_kind,
         _scope_id,
         _removed_user_id,
         _removed_device_id,
         _commit_event_id,
         _sponsor_user_id,
         _sponsor_device_id
       ),
       do: :ok

  defp maybe_complete_crypto_eviction(
         eviction_id,
         scope_kind,
         scope_id,
         removed_user_id,
         removed_device_id,
         commit_event_id,
         sponsor_user_id,
         sponsor_device_id
       ) do
    case Encryption.complete_pending_crypto_eviction(
           eviction_id,
           scope_kind,
           scope_id,
           removed_user_id,
           removed_device_id,
           commit_event_id,
           sponsor_user_id,
           sponsor_device_id
         ) do
      {:ok, _eviction} -> :ok
      {:error, reason} -> {:error, reason}
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
