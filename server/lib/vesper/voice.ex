defmodule Vesper.Voice do
  @moduledoc "Voice chat context — manages voice rooms and participants."

  alias Vesper.Voice.{Room, RoomSupervisor}

  def ensure_room(room_id, opts \\ []) do
    case Registry.lookup(Vesper.Voice.Registry, room_id) do
      [{_pid, _}] -> :ok
      [] -> {:ok, _pid} = RoomSupervisor.start_room(room_id, opts)
    end

    :ok
  end

  def join_room(room_id, user_id, channel_pid) do
    Room.join(room_id, user_id, channel_pid)
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

  def call_ring(room_id, caller_id) do
    Room.call_ring(room_id, caller_id)
  end

  def call_accept(room_id) do
    Room.call_accept(room_id)
  end
end
