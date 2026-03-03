defmodule VesperWeb.VoiceChannel do
  use Phoenix.Channel

  alias Vesper.Servers
  alias Vesper.Voice
  alias Vesper.Encryption

  @impl true
  def join("voice:channel:" <> channel_id, _payload, socket) do
    channel = Servers.get_channel(channel_id)

    cond do
      is_nil(channel) ->
        {:error, %{reason: "channel not found"}}

      channel.type != "voice" ->
        {:error, %{reason: "not a voice channel"}}

      not Servers.user_is_member?(socket.assigns.user_id, channel.server_id) ->
        {:error, %{reason: "not a member"}}

      true ->
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

    participant =
      Vesper.Repo.get_by(Vesper.Chat.DmParticipant,
        conversation_id: conversation_id,
        user_id: user_id
      )

    if participant do
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
  def handle_in("answer", %{"sdp" => sdp}, socket) do
    case Voice.sdp_answer(socket.assigns.room_id, socket.assigns.user_id, sdp) do
      :ok -> {:noreply, socket}
      {:error, _reason} -> {:reply, {:error, %{reason: "invalid answer"}}, socket}
    end
  end

  def handle_in("ice_candidate", %{"candidate" => candidate}, socket) do
    Voice.ice_candidate(socket.assigns.room_id, socket.assigns.user_id, candidate)
    {:noreply, socket}
  end

  def handle_in("mute", %{"muted" => muted}, socket) do
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

  def handle_in("mls_commit", %{"commit_data" => commit_data}, socket) do
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
      ) do
    room_id = socket.assigns.room_id
    sender_id = socket.assigns.user_id

    broadcast!(socket, "mls_welcome", %{
      recipient_id: recipient_id,
      welcome_data: welcome_data,
      sender_id: sender_id
    })

    # Store for offline delivery
    Encryption.store_pending_welcome(%{
      recipient_id: recipient_id,
      channel_id: room_id,
      welcome_data: Base.decode64!(welcome_data),
      sender_id: sender_id
    })

    {:noreply, socket}
  end

  @impl true
  def handle_info(:after_join, socket) do
    room_id = socket.assigns.room_id
    user_id = socket.assigns.user_id
    room_type = socket.assigns.room_type

    Voice.ensure_room(room_id, room_type: room_type)

    case Voice.join_room(room_id, user_id, self()) do
      {:ok, offer_sdp, track_map} ->
        push(socket, "offer", %{sdp: offer_sdp, track_map: track_map})

        broadcast!(socket, "voice_state_update", %{
          participants: Voice.get_participants(room_id)
        })

      {:error, :room_full} ->
        push(socket, "error", %{reason: "room is full"})

      {:error, reason} ->
        push(socket, "error", %{reason: inspect(reason)})
    end

    {:noreply, socket}
  end

  def handle_info({:renegotiate, sdp, track_map}, socket) do
    push(socket, "offer", %{sdp: sdp, track_map: track_map})
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
end
