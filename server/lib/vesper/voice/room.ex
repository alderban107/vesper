defmodule Vesper.Voice.Room do
  use GenServer, restart: :temporary

  require Logger

  alias ExWebRTC.{PeerConnection, SessionDescription, ICECandidate, MediaStreamTrack}

  @max_participants 25

  defstruct [
    :room_id,
    :room_type,
    :caller_id,
    :ring_timer_ref,
    participants: %{},
    call_state: nil
  ]

  # --- Public API ---

  def start_link(opts) do
    room_id = Keyword.fetch!(opts, :room_id)
    name = {:via, Registry, {Vesper.Voice.Registry, room_id}}
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  def join(room_id, user_id, channel_pid) do
    GenServer.call(via(room_id), {:join, user_id, channel_pid}, 10_000)
  end

  def leave(room_id, user_id) do
    GenServer.call(via(room_id), {:leave, user_id})
  end

  def sdp_answer(room_id, user_id, sdp) do
    GenServer.call(via(room_id), {:sdp_answer, user_id, sdp})
  end

  def ice_candidate(room_id, user_id, candidate) do
    GenServer.cast(via(room_id), {:ice_candidate, user_id, candidate})
  end

  def get_participants(room_id) do
    GenServer.call(via(room_id), :get_participants)
  end

  def set_muted(room_id, user_id, muted) do
    GenServer.cast(via(room_id), {:set_muted, user_id, muted})
  end

  def call_ring(room_id, caller_id) do
    GenServer.call(via(room_id), {:call_ring, caller_id})
  end

  def call_accept(room_id) do
    GenServer.call(via(room_id), :call_accept)
  end

  # --- Callbacks ---

  @impl true
  def init(opts) do
    # Trap exits so PeerConnection crashes don't take down the room
    Process.flag(:trap_exit, true)

    room_id = Keyword.fetch!(opts, :room_id)
    room_type = Keyword.get(opts, :room_type, :channel)

    state = %__MODULE__{
      room_id: room_id,
      room_type: room_type
    }

    {:ok, state}
  end

  @impl true
  def handle_call({:join, user_id, channel_pid}, _from, state) do
    if map_size(state.participants) >= @max_participants do
      {:reply, {:error, :room_full}, state}
    else
      case add_participant(state, user_id, channel_pid) do
        {:ok, offer_sdp, track_map, new_state} ->
          {:reply, {:ok, offer_sdp, track_map}, new_state}

        {:error, reason} ->
          {:reply, {:error, reason}, state}
      end
    end
  end

  def handle_call({:leave, user_id}, _from, state) do
    new_state = remove_participant(state, user_id)

    if map_size(new_state.participants) == 0 do
      {:stop, :normal, :ok, new_state}
    else
      {:reply, :ok, new_state}
    end
  end

  def handle_call({:sdp_answer, user_id, sdp}, _from, state) do
    case Map.get(state.participants, user_id) do
      nil ->
        {:reply, {:error, :not_found}, state}

      participant ->
        description = %SessionDescription{type: :answer, sdp: sdp}

        case PeerConnection.set_remote_description(participant.pc, description) do
          :ok ->
            # Apply any pending ICE candidates
            new_participant =
              Enum.reduce(participant.pending_candidates, participant, fn candidate, p ->
                case PeerConnection.add_ice_candidate(p.pc, candidate) do
                  :ok ->
                    :ok

                  {:error, reason} ->
                    Logger.warning("Failed to add ICE candidate: #{inspect(reason)}")
                end

                p
              end)

            new_participant = %{new_participant | pending_candidates: [], negotiating: false}

            # Process any pending renegotiation
            new_state = put_in(state.participants[user_id], new_participant)

            new_state =
              if new_participant.renegotiate_pending do
                trigger_renegotiation(new_state, user_id)
              else
                new_state
              end

            {:reply, :ok, new_state}

          {:error, reason} ->
            {:reply, {:error, reason}, state}
        end
    end
  end

  def handle_call(:get_participants, _from, state) do
    participants =
      Enum.map(state.participants, fn {user_id, p} ->
        %{user_id: user_id, muted: p.muted}
      end)

    {:reply, participants, state}
  end

  def handle_call({:call_ring, caller_id}, _from, state) do
    timer_ref = Process.send_after(self(), :call_timeout, 30_000)

    new_state = %{state | call_state: :ringing, caller_id: caller_id, ring_timer_ref: timer_ref}
    {:reply, :ok, new_state}
  end

  def handle_call(:call_accept, _from, state) do
    if state.ring_timer_ref, do: Process.cancel_timer(state.ring_timer_ref)
    new_state = %{state | call_state: :active, ring_timer_ref: nil}
    {:reply, :ok, new_state}
  end

  @impl true
  def handle_cast({:ice_candidate, user_id, candidate_json}, state) do
    case Map.get(state.participants, user_id) do
      nil ->
        {:noreply, state}

      participant ->
        try do
          candidate = ICECandidate.from_json(candidate_json)

          if PeerConnection.get_remote_description(participant.pc) do
            case PeerConnection.add_ice_candidate(participant.pc, candidate) do
              :ok ->
                :ok

              {:error, reason} ->
                Logger.warning("Failed to add ICE candidate: #{inspect(reason)}")
            end

            {:noreply, state}
          else
            updated = %{
              participant
              | pending_candidates: participant.pending_candidates ++ [candidate]
            }

            {:noreply, put_in(state.participants[user_id], updated)}
          end
        rescue
          e ->
            Logger.warning("Malformed ICE candidate from user #{user_id}: #{inspect(e)}")

            {:noreply, state}
        end
    end
  end

  def handle_cast({:set_muted, user_id, muted}, state) do
    case Map.get(state.participants, user_id) do
      nil ->
        {:noreply, state}

      participant ->
        updated = %{participant | muted: muted}
        {:noreply, put_in(state.participants[user_id], updated)}
    end
  end

  @impl true
  def handle_info({:ex_webrtc, pc, {:rtp, _track_id, _rid, packet}}, state) do
    # Find the sender by their PeerConnection
    sender_id = find_user_by_pc(state, pc)

    if sender_id do
      # Forward to all other participants
      Enum.each(state.participants, fn {uid, participant} ->
        if uid != sender_id do
          case Map.get(participant.outgoing_tracks, sender_id) do
            nil -> :ok
            out_track_id -> PeerConnection.send_rtp(participant.pc, out_track_id, packet)
          end
        end
      end)
    end

    {:noreply, state}
  end

  def handle_info({:ex_webrtc, pc, {:ice_candidate, candidate}}, state) do
    user_id = find_user_by_pc(state, pc)

    if user_id do
      participant = state.participants[user_id]
      send(participant.channel_pid, {:ice_candidate, ICECandidate.to_json(candidate)})
    end

    {:noreply, state}
  end

  def handle_info({:ex_webrtc, pc, {:track, track}}, state) do
    user_id = find_user_by_pc(state, pc)

    if user_id do
      updated = %{state.participants[user_id] | audio_track_id: track.id}
      {:noreply, put_in(state.participants[user_id], updated)}
    else
      {:noreply, state}
    end
  end

  def handle_info({:ex_webrtc, pc, {:connection_state_change, :failed}}, state) do
    user_id = find_user_by_pc(state, pc)

    if user_id do
      Logger.warning("PeerConnection failed for user #{user_id} in room #{state.room_id}")
      new_state = remove_participant(state, user_id)

      if map_size(new_state.participants) == 0 do
        {:stop, :normal, new_state}
      else
        {:noreply, new_state}
      end
    else
      {:noreply, state}
    end
  end

  def handle_info({:ex_webrtc, _pc, _msg}, state) do
    # Ignore other ex_webrtc messages (state changes, gathering, etc.)
    {:noreply, state}
  end

  def handle_info({:EXIT, pid, _reason}, state) do
    # Linked PeerConnection crashed — clean up that participant
    user_id = find_user_by_pc(state, pid)

    if user_id do
      new_state = remove_participant(state, user_id)

      if map_size(new_state.participants) == 0 do
        {:stop, :normal, new_state}
      else
        {:noreply, new_state}
      end
    else
      {:noreply, state}
    end
  end

  def handle_info({:DOWN, _ref, :process, pid, _reason}, state) do
    # Channel process died — clean up that participant
    user_id = find_user_by_channel_pid(state, pid)

    if user_id do
      new_state = remove_participant(state, user_id)

      if map_size(new_state.participants) == 0 do
        {:stop, :normal, new_state}
      else
        {:noreply, new_state}
      end
    else
      {:noreply, state}
    end
  end

  def handle_info(:call_timeout, %{call_state: :ringing} = state) do
    # Notify all participants about timeout
    Enum.each(state.participants, fn {_uid, p} ->
      send(p.channel_pid, :call_timeout)
    end)

    {:stop, :normal, state}
  end

  def handle_info(:call_timeout, state) do
    # Already accepted or call state changed, ignore
    {:noreply, state}
  end

  # --- Private Helpers ---

  defp via(room_id) do
    {:via, Registry, {Vesper.Voice.Registry, room_id}}
  end

  defp ice_servers do
    Application.get_env(:vesper, :ice_servers, [])
  end

  defp add_participant(state, user_id, channel_pid) do
    # Monitor the channel process for cleanup
    Process.monitor(channel_pid)

    # Create PeerConnection
    pc_opts = [
      ice_servers: ice_servers(),
      controlling_process: self()
    ]

    case PeerConnection.start_link(pc_opts) do
      {:ok, pc} ->
        # Unlink so DTLS/ICE sub-process crashes don't take down the Room.
        # We don't monitor the PC — if it dies, the participant stays in state
        # and gets cleaned up when their channel process leaves.
        Process.unlink(pc)

        # Add a recvonly transceiver for incoming audio from this user
        {:ok, _recv_tr} = PeerConnection.add_transceiver(pc, :audio, direction: :recvonly)

        # Add sendonly transceivers for each existing participant's audio
        outgoing_tracks =
          Enum.reduce(state.participants, %{}, fn {existing_uid, _existing_p}, acc ->
            track = MediaStreamTrack.new(:audio)
            {:ok, _sender} = PeerConnection.add_track(pc, track)
            Map.put(acc, existing_uid, track.id)
          end)

        # Create offer for this new participant
        {:ok, offer} = PeerConnection.create_offer(pc)
        :ok = PeerConnection.set_local_description(pc, offer)

        # Build track_map: which outgoing track corresponds to which user
        transceivers = PeerConnection.get_transceivers(pc)

        track_map =
          Enum.reduce(transceivers, %{}, fn tr, acc ->
            case tr.direction do
              :sendonly ->
                # Find which user this track is for
                matching =
                  Enum.find(outgoing_tracks, fn {_uid, tid} -> tid == tr.sender.track.id end)

                case matching do
                  {uid, _} -> Map.put(acc, tr.mid, uid)
                  nil -> acc
                end

              _ ->
                acc
            end
          end)

        new_participant = %{
          pc: pc,
          channel_pid: channel_pid,
          audio_track_id: nil,
          outgoing_tracks: outgoing_tracks,
          muted: false,
          pending_candidates: [],
          negotiating: true,
          renegotiate_pending: false,
          track_map: track_map
        }

        new_state = put_in(state.participants[user_id], new_participant)

        # For each existing participant: add an outgoing track for the new user's audio
        new_state =
          Enum.reduce(state.participants, new_state, fn {existing_uid, _existing_p}, acc_state ->
            add_outgoing_track_and_renegotiate(acc_state, existing_uid, user_id)
          end)

        {:ok, offer.sdp, track_map, new_state}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp add_outgoing_track_and_renegotiate(state, target_user_id, source_user_id) do
    target = state.participants[target_user_id]

    # Add a new outgoing track for the source user's audio
    track = MediaStreamTrack.new(:audio)
    {:ok, _sender} = PeerConnection.add_track(target.pc, track)

    outgoing = Map.put(target.outgoing_tracks, source_user_id, track.id)
    updated_target = %{target | outgoing_tracks: outgoing}
    state = put_in(state.participants[target_user_id], updated_target)

    # Trigger renegotiation
    trigger_renegotiation(state, target_user_id)
  end

  defp trigger_renegotiation(state, user_id) do
    participant = state.participants[user_id]

    if participant.negotiating do
      # Already in the middle of an SDP exchange — defer
      updated = %{participant | renegotiate_pending: true}
      put_in(state.participants[user_id], updated)
    else
      do_renegotiate(state, user_id)
    end
  end

  defp do_renegotiate(state, user_id) do
    participant = state.participants[user_id]

    case PeerConnection.create_offer(participant.pc) do
      {:ok, offer} ->
        :ok = PeerConnection.set_local_description(participant.pc, offer)

        # Build updated track_map
        transceivers = PeerConnection.get_transceivers(participant.pc)

        track_map =
          Enum.reduce(transceivers, %{}, fn tr, acc ->
            if tr.direction in [:sendonly, :sendrecv] and tr.sender.track do
              matching =
                Enum.find(participant.outgoing_tracks, fn {_uid, tid} ->
                  tid == tr.sender.track.id
                end)

              case matching do
                {uid, _} -> Map.put(acc, tr.mid, uid)
                nil -> acc
              end
            else
              acc
            end
          end)

        updated = %{
          participant
          | negotiating: true,
            renegotiate_pending: false,
            track_map: track_map
        }

        state = put_in(state.participants[user_id], updated)

        send(participant.channel_pid, {:renegotiate, offer.sdp, track_map})

        state

      {:error, reason} ->
        Logger.error("Failed to create renegotiation offer: #{inspect(reason)}")
        state
    end
  end

  defp remove_participant(state, user_id) do
    case Map.pop(state.participants, user_id) do
      {nil, _} ->
        state

      {participant, remaining} ->
        # Close the PeerConnection asynchronously — DTLS NIF close can crash,
        # and we don't want that to block or affect the Room process.
        spawn(fn ->
          try do
            PeerConnection.close(participant.pc)
          catch
            _, _ -> :ok
          end
        end)

        state = %{state | participants: remaining}

        # Remove outgoing tracks for this user from all remaining participants
        # and renegotiate
        Enum.reduce(remaining, state, fn {other_uid, other_p}, acc_state ->
          {_removed, new_outgoing} = Map.pop(other_p.outgoing_tracks, user_id)
          updated = %{other_p | outgoing_tracks: new_outgoing}
          acc_state = put_in(acc_state.participants[other_uid], updated)

          # Only renegotiate if we actually had a track for the leaving user
          if Map.has_key?(other_p.outgoing_tracks, user_id) do
            trigger_renegotiation(acc_state, other_uid)
          else
            acc_state
          end
        end)
    end
  end

  defp find_user_by_pc(state, pc) do
    Enum.find_value(state.participants, fn {user_id, p} ->
      if p.pc == pc, do: user_id
    end)
  end

  defp find_user_by_channel_pid(state, pid) do
    Enum.find_value(state.participants, fn {user_id, p} ->
      if p.channel_pid == pid, do: user_id
    end)
  end
end
