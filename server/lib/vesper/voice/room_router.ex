defmodule Vesper.Voice.Room.Router do
  @moduledoc """
  Data-plane process for voice rooms. Handles RTP packet forwarding and
  WebSocket media frame relay, keeping the hot path off the Room control
  GenServer's mailbox.

  Linked to the Room process — dies when Room dies. If the Router crashes,
  the Room detects it via :EXIT and restarts it.
  """

  use GenServer

  alias ExWebRTC.{PeerConnection, ICECandidate}

  defstruct [
    :room_pid,
    :room_id,
    pc_to_user: %{},
    participants: %{}
  ]

  # --- Public API ---

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  def relay_media_frame(router_pid, sender_id, slot, data, seq) do
    GenServer.cast(router_pid, {:relay_media_frame, sender_id, slot, data, seq})
  end

  # --- Callbacks ---

  @impl true
  def init(opts) do
    room_pid = Keyword.fetch!(opts, :room_pid)
    room_id = Keyword.fetch!(opts, :room_id)

    # GC tuning for binary-heavy RTP forwarding
    Process.flag(:min_bin_vheap_size, 233_681)
    Process.flag(:fullsweep_after, 20)
    max_heap = Application.get_env(:vesper, :voice_router_max_heap_size, 50_000_000)
    Process.flag(:max_heap_size, %{size: max_heap, kill: true, error_logger: true})

    {:ok, %__MODULE__{room_pid: room_pid, room_id: room_id}}
  end

  # --- RTP forwarding (hot path) ---

  @impl true
  def handle_info({:ex_webrtc, pc, {:rtp, track_id, _rid, packet}}, state) do
    sender_id = Map.get(state.pc_to_user, pc)

    if sender_id do
      sender_participant = Map.get(state.participants, sender_id)

      media_slot =
        if sender_participant do
          sender_participant
          |> Map.get(:incoming_track_slots, %{})
          |> Map.get(track_id, :voice_audio)
        else
          :voice_audio
        end

      # Forward to all other participants (cross-transport aware)
      Enum.each(state.participants, fn {uid, participant} ->
        if uid != sender_id do
          case participant.transport do
            :webrtc ->
              outgoing_track_id =
                participant.outgoing_tracks
                |> Map.get(sender_id, %{})
                |> Map.get(media_slot)

              case outgoing_track_id do
                nil -> :ok
                out_track_id -> PeerConnection.send_rtp(participant.pc, out_track_id, packet)
              end

            :websocket ->
              # Cross-transport: encode RTP bytes for WebSocket delivery
              send(
                participant.channel_pid,
                {:media_frame, sender_id, Atom.to_string(media_slot), Base.encode64(packet), 0}
              )
          end
        end
      end)
    end

    {:noreply, state}
  end

  # ICE candidate from PeerConnection -> forward to client channel
  def handle_info({:ex_webrtc, pc, {:ice_candidate, candidate}}, state) do
    user_id = Map.get(state.pc_to_user, pc)

    if user_id do
      participant = state.participants[user_id]

      if participant do
        send(participant.channel_pid, {:ice_candidate, ICECandidate.to_json(candidate)})
      end
    end

    {:noreply, state}
  end

  # New track from PeerConnection -> update local slots + notify Room
  def handle_info({:ex_webrtc, pc, {:track, track}}, state) do
    user_id = Map.get(state.pc_to_user, pc)

    if user_id do
      participant = state.participants[user_id]

      if participant do
        incoming_track_slots =
          participant
          |> Map.get(:incoming_track_slots, %{})
          |> Map.put(track.id, :voice_audio)

        updated = Map.put(participant, :incoming_track_slots, incoming_track_slots)
        state = put_in(state.participants[user_id], updated)

        # Notify Room for canonical state update (with full track info)
        send(state.room_pid, {:router_track_event, pc, track})

        {:noreply, state}
      else
        {:noreply, state}
      end
    else
      {:noreply, state}
    end
  end

  # Connection failed -> forward to Room for participant cleanup
  def handle_info({:ex_webrtc, pc, {:connection_state_change, :failed}}, state) do
    send(state.room_pid, {:pc_failed, pc})
    {:noreply, state}
  end

  # Ignore other ExWebRTC messages
  def handle_info({:ex_webrtc, _pc, _msg}, state) do
    {:noreply, state}
  end

  def handle_info(_msg, state) do
    {:noreply, state}
  end

  # --- Routing table updates from Room ---

  @impl true
  def handle_cast({:update_routing_table, table}, state) do
    {:noreply, %{state | pc_to_user: table.pc_to_user, participants: table.participants}}
  end

  # --- WebSocket media frame relay ---

  def handle_cast({:relay_media_frame, sender_id, slot, data_b64, seq}, state) do
    Enum.each(state.participants, fn {uid, participant} ->
      if uid != sender_id do
        case participant.transport do
          :websocket ->
            send(participant.channel_pid, {:media_frame, sender_id, slot, data_b64, seq})

          :webrtc ->
            # Cross-transport: decode base64 -> raw RTP, send via PeerConnection
            case Base.decode64(data_b64) do
              {:ok, rtp_bytes} ->
                normalized_slot = normalize_slot(slot)

                outgoing_track_id =
                  participant.outgoing_tracks
                  |> Map.get(sender_id, %{})
                  |> Map.get(normalized_slot)

                if outgoing_track_id do
                  PeerConnection.send_rtp(participant.pc, outgoing_track_id, rtp_bytes)
                end

              :error ->
                :ok
            end
        end
      end
    end)

    {:noreply, state}
  end

  # --- Private ---

  defp normalize_slot("voice_audio"), do: :voice_audio
  defp normalize_slot("share_audio"), do: :share_audio
  defp normalize_slot("camera_video"), do: :camera_video
  defp normalize_slot("share_video"), do: :share_video
  defp normalize_slot(slot) when is_atom(slot), do: slot
  defp normalize_slot(_), do: :voice_audio
end
