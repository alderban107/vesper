defmodule Vesper.Voice do
  @moduledoc "Voice chat context — manages voice rooms and participants."

  alias Vesper.Voice.{Room, RoomSupervisor}

  def ensure_room(room_id, opts \\ []) do
    case RoomSupervisor.start_room(room_id, opts) do
      {:ok, _pid} -> :ok
      {:error, _reason} = error -> error
    end
  end

  def join_room(room_id, user_id, channel_pid, opts \\ []) do
    Room.join(room_id, user_id, channel_pid, opts)
  end

  def leave_room(room_id, user_id) do
    try do
      Room.leave(room_id, user_id)
    catch
      :exit, _ -> :ok
    end
  end

  def sdp_answer(room_id, user_id, sdp) do
    Room.sdp_answer(room_id, user_id, sdp)
  end

  def ice_candidate(room_id, user_id, candidate) do
    Room.ice_candidate(room_id, user_id, candidate)
  end

  def get_participants(room_id) do
    try do
      Room.get_participants(room_id)
    catch
      :exit, _ -> []
    end
  end

  def set_muted(room_id, user_id, muted) do
    Room.set_muted(room_id, user_id, muted)
  end

  def set_media_slot_active(room_id, user_id, slot, active) do
    Room.set_media_slot_active(room_id, user_id, slot, active)
  end

  def call_ring(room_id, caller_id) do
    Room.call_ring(room_id, caller_id)
  end

  def call_accept(room_id) do
    Room.call_accept(room_id)
  end

  def call_reject(room_id, user_id) do
    try do
      Room.call_reject(room_id, user_id)
    catch
      :exit, _ -> :ok
    end
  end

  def relay_media_frame(room_id, user_id, slot, data, seq) do
    case Registry.lookup(Vesper.Voice.Registry, room_id) do
      [{room_pid, _}] ->
        case GenServer.call(room_pid, :get_router) do
          router_pid when is_pid(router_pid) ->
            Vesper.Voice.Room.Router.relay_media_frame(router_pid, user_id, slot, data, seq)

          _ ->
            :ok
        end

      [] ->
        :ok
    end
  end
end
