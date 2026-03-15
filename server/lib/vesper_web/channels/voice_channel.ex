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
  def join("voice:channel:" <> channel_id, _payload, socket) do
    case Servers.get_channel_if_member(channel_id, socket.assigns.user_id) do
      nil ->
        {:error, %{reason: "channel not found or not a member"}}

      %{type: type} when type != "voice" ->
        {:error, %{reason: "not a voice channel"}}

      _channel ->
        socket =
          socket
          |> assign(:room_id, channel_id)
          |> assign(:room_type, :channel)

        send(self(), :after_join)
        {:ok, socket}
    end
  end

  def join("voice:dm:" <> conversation_id, _payload, socket) do
    user_id = socket.assigns.user_id

    if Chat.user_is_participant?(user_id, conversation_id) do
      socket =
        socket
        |> assign(:room_id, conversation_id)
        |> assign(:room_type, :dm)

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
  def handle_in("mls_request_join", _payload, socket) do
    broadcast_from!(socket, "mls_request_join", %{
      user_id: socket.assigns.user_id
    })

    {:noreply, socket}
  end

  def handle_in("mls_request_join_all", _payload, socket) do
    broadcast_from!(socket, "mls_request_join_all", %{
      user_id: socket.assigns.user_id
    })

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
        "mls_welcome",
        %{"recipient_id" => recipient_id, "welcome_data" => welcome_data},
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
                 group_id: group_id,
                 welcome_data: decoded,
                 sender_id: sender_id
               }
               |> put_voice_scope(room_id, room_type)
             ) do
          {:ok, _welcome} ->
            broadcast!(socket, "mls_welcome", %{
              recipient_id: recipient_id,
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

  def handle_in(_event, _payload, socket),
    do: {:reply, {:error, %{reason: "unrecognized event"}}, socket}

  @impl true
  def handle_info(:after_join, socket) do
    room_id = socket.assigns.room_id
    user_id = socket.assigns.user_id
    room_type = socket.assigns.room_type

    Voice.ensure_room(room_id, room_type: room_type)

    # Semaphore.call returns the function's result directly, or {:error, :max}
    case Semaphore.call({:voice_room, room_id}, @max_concurrent_voice_ops, fn ->
           Voice.join_room(room_id, user_id, self())
         end) do
      {:ok, offer_sdp, track_map, publish_map} ->
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
end
