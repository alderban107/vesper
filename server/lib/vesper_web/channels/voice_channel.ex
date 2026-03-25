defmodule VesperWeb.VoiceChannel do
  use Phoenix.Channel

  alias Vesper.Servers
  alias Vesper.Chat
  alias Vesper.Voice
  alias Vesper.Encryption
  import VesperWeb.ChannelHelpers, only: [safe_decode64: 1]

  # Max concurrent Voice.Room operations per room before rejecting with backpressure
  @max_concurrent_voice_ops 10

  @impl true
  def join("voice:channel:" <> channel_id, payload, socket) do
    case Servers.get_channel_if_member(channel_id, socket.assigns.user_id) do
      nil ->
        {:error, %{reason: "channel not found or not a member"}}

      %{type: type} when type != "voice" ->
        {:error, %{reason: "not a voice channel"}}

      channel ->
        Phoenix.PubSub.subscribe(Vesper.PubSub, "server:members:#{channel.server_id}")
        transport = normalize_transport(Map.get(payload, "transport", "webrtc"))

        socket =
          socket
          |> assign(:room_id, channel_id)
          |> assign(:room_type, :channel)
          |> assign(:server_id, channel.server_id)
          |> assign(:transport, transport)

        send(self(), :after_join)
        {:ok, socket}
    end
  end

  def join("voice:dm:" <> conversation_id, payload, socket) do
    user_id = socket.assigns.user_id

    if Chat.user_is_participant?(user_id, conversation_id) do
      transport = normalize_transport(Map.get(payload, "transport", "webrtc"))

      socket =
        socket
        |> assign(:room_id, conversation_id)
        |> assign(:room_type, :dm)
        |> assign(:transport, transport)

      send(self(), :after_join)
      {:ok, socket}
    else
      {:error, %{reason: "not a participant"}}
    end
  end

  @impl true
  def handle_in("answer", %{"sdp" => sdp}, socket) when is_binary(sdp) do
    case Voice.sdp_answer(socket.assigns.room_id, socket.assigns.user_id, sdp) do
      :ok -> {:noreply, socket}
      {:error, _reason} -> {:reply, {:error, %{reason: "invalid answer"}}, socket}
    end
  end

  def handle_in("ice_candidate", %{"candidate" => candidate}, socket) when is_map(candidate) do
    Voice.ice_candidate(socket.assigns.room_id, socket.assigns.user_id, candidate)
    {:noreply, socket}
  end

  def handle_in("mute", %{"muted" => muted}, socket) when is_boolean(muted) do
    Voice.set_muted(socket.assigns.room_id, socket.assigns.user_id, muted)

    broadcast!(socket, "voice_state_update", %{
      participants: Voice.get_participants(socket.assigns.room_id)
    })

    {:noreply, socket}
  end

  def handle_in("media_state", %{"slot" => slot, "active" => active}, socket)
      when is_binary(slot) and is_boolean(active) do
    :ok =
      Voice.set_media_slot_active(socket.assigns.room_id, socket.assigns.user_id, slot, active)

    broadcast!(socket, "voice_state_update", %{
      participants: Voice.get_participants(socket.assigns.room_id)
    })

    {:noreply, socket}
  end

  # Voice E2EE key exchange — server relays MLS ciphertext without reading it
  def handle_in("voice_key", payload, socket) do
    broadcast_from!(socket, "voice_key", Map.put(payload, "sender_id", socket.assigns.user_id))
    {:noreply, socket}
  end

  # DM call signaling
  def handle_in("call_ring", _payload, socket) do
    if socket.assigns.room_type != :dm do
      {:reply, {:error, %{reason: "call_ring only for DMs"}}, socket}
    else
      room_id = socket.assigns.room_id
      caller_id = socket.assigns.user_id

      Voice.call_ring(room_id, caller_id)

      # Broadcast incoming_call to all DM participants via the dm topic
      VesperWeb.Endpoint.broadcast("dm:#{room_id}", "incoming_call", %{
        caller_id: caller_id,
        conversation_id: room_id
      })

      # Also broadcast on the backing channel topic for DM-as-channels migration
      case Chat.get_dm_context_for_channel_by_conversation(room_id) do
        {:ok, channel_id} ->
          VesperWeb.Endpoint.broadcast("chat:channel:#{channel_id}", "incoming_call", %{
            caller_id: caller_id,
            conversation_id: room_id
          })

        _ ->
          :ok
      end

      # Push notification for offline DM participants
      participant_ids = Chat.list_participant_ids(room_id)

      Vesper.Notifications.notify_incoming_call(
        caller_id,
        room_id,
        participant_ids
      )

      {:noreply, socket}
    end
  end

  def handle_in("call_accept", _payload, socket) do
    Voice.call_accept(socket.assigns.room_id)
    {:noreply, socket}
  end

  def handle_in("call_reject", _payload, socket) do
    broadcast!(socket, "call_rejected", %{
      user_id: socket.assigns.user_id
    })

    # If no participants left after rejection, room stops on its own via leave
    {:noreply, socket}
  end

  # MLS events for voice E2EE (same pattern as ChatChannel)
  def handle_in("mls_request_join", payload, socket) when is_map(payload) do
    broadcast_from!(socket, "mls_request_join", %{
      user_id: socket.assigns.user_id,
      username: socket.assigns.username,
      device_id: Map.get(payload, "device_id") || socket.assigns.device_client_id
    })

    {:reply, :ok, socket}
  end

  def handle_in("mls_request_join_all", _payload, socket) do
    room_id = socket.assigns.room_id
    room_type = socket.assigns.room_type

    case Encryption.store_mls_event(
           %{
             group_id: voice_group_id(room_id, room_type),
             event_type: "mls_request_join_all",
             payload: %{user_id: socket.assigns.user_id},
             sender_id: socket.assigns.user_id,
             sender_device_id: socket.assigns.device_client_id
           }
           |> put_voice_scope(room_id, room_type)
         ) do
      {:ok, event} ->
        broadcast_from!(socket, "mls_request_join_all", %{
          user_id: socket.assigns.user_id
        })

        {:reply, {:ok, %{seq: event.id}}, socket}

      {:error, _changeset} ->
        {:reply, {:error, %{reason: "could not store join request"}}, socket}
    end
  end

  def handle_in("mls_resync_request", payload, socket) when is_map(payload) do
    case normalize_resync_request(payload) do
      {:ok, attrs} ->
        room_id = socket.assigns.room_id
        room_type = socket.assigns.room_type
        group_id = voice_group_id(room_id, room_type)

        case Encryption.store_pending_resync_request(
               %{
                 group_id: group_id,
                 request_id: attrs.request_id,
                 requester_id: socket.assigns.user_id,
                 requester_username: socket.assigns.username,
                 requester_client_id:
                   Map.get(payload, "device_id") || socket.assigns.device_client_id,
                 last_known_epoch: attrs.last_known_epoch,
                 reason: attrs.reason
               }
               |> put_voice_scope(room_id, room_type)
             ) do
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

  def handle_in("mls_commit", %{"commit_data" => commit_data} = payload, socket)
      when is_binary(commit_data) do
    room_id = socket.assigns.room_id
    room_type = socket.assigns.room_type

    idempotency_key =
      case Map.get(payload, "idempotency_key") || Map.get(payload, "commit_id") do
        value when is_binary(value) and value != "" -> value
        _ -> nil
      end

    case Encryption.store_mls_commit_event(
           %{
             group_id: voice_group_id(room_id, room_type),
             event_type: "mls_commit",
             payload: %{commit_data: commit_data},
             sender_id: socket.assigns.user_id,
             sender_device_id: socket.assigns.device_client_id
           }
           |> put_voice_scope(room_id, room_type)
           |> maybe_put(:idempotency_key, idempotency_key)
         ) do
      {:ok, event} ->
        broadcast!(socket, "mls_commit", %{
          seq: event.id,
          commit_data: commit_data,
          sender_id: socket.assigns.user_id,
          sender_device_id: socket.assigns.device_client_id
        })

        {:reply, {:ok, %{seq: event.id}}, socket}

      {:error, _changeset} ->
        {:reply, {:error, %{reason: "could not store commit"}}, socket}
    end
  end

  def handle_in(
        "mls_remove",
        %{"removed_user_id" => removed_user_id, "commit_data" => commit_data},
        socket
      )
      when is_binary(removed_user_id) and is_binary(commit_data) do
    room_id = socket.assigns.room_id
    room_type = socket.assigns.room_type

    case Encryption.store_mls_remove_event(
           %{
             group_id: voice_group_id(room_id, room_type),
             event_type: "mls_remove",
             payload: %{
               removed_user_id: removed_user_id,
               commit_data: commit_data
             },
             sender_id: socket.assigns.user_id,
             sender_device_id: socket.assigns.device_client_id
           }
           |> put_voice_scope(room_id, room_type)
         ) do
      {:ok, event} ->
        broadcast!(socket, "mls_remove", %{
          seq: event.id,
          removed_user_id: removed_user_id,
          commit_data: commit_data,
          sender_id: socket.assigns.user_id,
          sender_device_id: socket.assigns.device_client_id
        })

        {:reply, {:ok, %{seq: event.id}}, socket}

      {:error, reason} when is_atom(reason) ->
        {:reply, {:error, %{reason: inspect(reason)}}, socket}

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
        room_id = socket.assigns.room_id
        room_type = socket.assigns.room_type
        sender_id = socket.assigns.user_id
        group_id = voice_group_id(room_id, room_type)

        case Encryption.store_pending_welcome(
               %{
                 recipient_id: recipient_id,
                 recipient_client_id: Map.get(payload, "recipient_device_id"),
                 recipient_key_package_ref: Map.get(payload, "key_package_ref"),
                 group_id: group_id,
                 welcome_data: decoded,
                 sender_id: sender_id
               }
               |> put_voice_scope(room_id, room_type)
             ) do
          {:ok, welcome} ->
            broadcast!(socket, "mls_welcome", %{
              id: welcome.id,
              recipient_id: recipient_id,
              recipient_device_id: welcome.recipient_client_id,
              key_package_ref: welcome.recipient_key_package_ref,
              welcome_data: welcome_data,
              sender_id: sender_id
            })

            {:reply, {:ok, %{id: welcome.id}}, socket}

          {:error, _changeset} ->
            {:reply, {:error, %{reason: "could not store welcome"}}, socket}
        end

      {:error, _} ->
        {:reply, {:error, %{reason: "invalid encoding"}}, socket}
    end
  end

  # WebSocket media relay — clients send encoded frames over the channel
  def handle_in("media_frame", %{"slot" => slot, "data" => data} = payload, socket)
      when is_binary(slot) and is_binary(data) do
    seq = Map.get(payload, "seq", 0)
    Voice.relay_media_frame(socket.assigns.room_id, socket.assigns.user_id, slot, data, seq)
    {:noreply, socket}
  end

  def handle_in(_event, _payload, socket),
    do: {:reply, {:error, %{reason: "unrecognized event"}}, socket}

  @impl true
  def handle_info(:after_join, socket) do
    room_id = socket.assigns.room_id
    user_id = socket.assigns.user_id
    room_type = socket.assigns.room_type
    transport = socket.assigns[:transport] || :webrtc

    Voice.ensure_room(room_id, room_type: room_type)

    join_opts = [transport: transport]

    # Semaphore.call returns the function's result directly, or {:error, :max}
    case Semaphore.call({:voice_room, room_id}, @max_concurrent_voice_ops, fn ->
           Voice.join_room(room_id, user_id, self(), join_opts)
         end) do
      {:ok, :websocket, _track_map, _publish_map} ->
        # WebSocket transport — no SDP/ICE needed
        replay_recent_mls_join_broadcasts(socket)

        push(socket, "joined", %{
          transport: "websocket",
          e2ee_creator_id: preferred_creator_id(room_id, user_id)
        })

        broadcast!(socket, "voice_state_update", %{
          participants: Voice.get_participants(room_id)
        })

      {:ok, offer_sdp, track_map, publish_map} ->
        replay_recent_mls_join_broadcasts(socket)

        push(socket, "offer", %{
          sdp: offer_sdp,
          track_map: track_map,
          publish_map: publish_map,
          e2ee_creator_id: preferred_creator_id(room_id, user_id)
        })

        broadcast!(socket, "voice_state_update", %{
          participants: Voice.get_participants(room_id)
        })

      {:error, :room_full} ->
        push(socket, "error", %{reason: "room is full"})

      {:error, :max} ->
        push(socket, "error", %{reason: "server busy, try again"})

      {:error, reason} ->
        push(socket, "error", %{reason: inspect(reason)})
    end

    {:noreply, socket}
  end

  def handle_info({:renegotiate, sdp, track_map, publish_map}, socket) do
    push(socket, "offer", %{
      sdp: sdp,
      track_map: track_map,
      publish_map: publish_map,
      e2ee_creator_id: preferred_creator_id(socket.assigns.room_id, socket.assigns.user_id)
    })

    {:noreply, socket}
  end

  def handle_info({:ice_candidate, candidate}, socket) do
    push(socket, "ice_candidate", %{candidate: candidate})
    {:noreply, socket}
  end

  def handle_info(:call_timeout, socket) do
    push(socket, "call_timeout", %{})
    {:noreply, socket}
  end

  def handle_info({:member_left, server_id, user_id}, socket)
      when socket.assigns.room_type == :channel and
             server_id == socket.assigns.server_id and
             user_id == socket.assigns.user_id do
    {:stop, {:shutdown, :membership_revoked}, socket}
  end

  def handle_info({:media_frame, sender_id, slot, data, seq}, socket) do
    push(socket, "media_frame", %{
      sender_id: sender_id,
      slot: slot,
      data: data,
      seq: seq
    })

    {:noreply, socket}
  end

  def handle_info(_msg, socket), do: {:noreply, socket}

  @impl true
  def terminate(_reason, socket) do
    try do
      Voice.leave_room(socket.assigns.room_id, socket.assigns.user_id)

      broadcast!(socket, "voice_state_update", %{
        participants: Voice.get_participants(socket.assigns.room_id)
      })
    catch
      _, _ -> :ok
    end

    :ok
  end

  defp put_voice_scope(attrs, room_id, :channel) do
    Map.put(attrs, :channel_id, room_id)
  end

  defp put_voice_scope(attrs, room_id, :dm) do
    Map.put(attrs, :conversation_id, room_id)
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

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

  defp voice_group_id(room_id, room_type) do
    "voice:#{room_type}:#{room_id}"
  end

  defp preferred_creator_id(room_id, fallback_user_id) do
    case Voice.get_participants(room_id) do
      [] ->
        fallback_user_id

      participants ->
        participants
        |> Enum.map(& &1.user_id)
        |> Enum.min()
    end
  end

  defp replay_recent_mls_join_broadcasts(socket) do
    group_id = voice_group_id(socket.assigns.room_id, socket.assigns.room_type)
    user_id = socket.assigns.user_id

    Encryption.list_recent_mls_events(group_id, 50, "mls_request_join_all")
    |> Enum.filter(fn event ->
      event.sender_id != user_id
    end)
    |> Enum.uniq_by(& &1.sender_id)
    |> Enum.each(fn event ->
      push(socket, "mls_request_join_all", %{
        user_id: event.sender_id
      })
    end)
  end

  defp normalize_transport("websocket"), do: :websocket
  defp normalize_transport("ws"), do: :websocket
  defp normalize_transport(_), do: :webrtc
end
