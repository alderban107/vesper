defmodule Vesper.Voice.RoomSupervisor do
  use DynamicSupervisor

  def start_link(_opts) do
    DynamicSupervisor.start_link(__MODULE__, :ok, name: __MODULE__)
  end

  # Limit concurrent voice rooms to prevent unbounded resource consumption
  @max_rooms 500

  @impl true
  def init(:ok) do
    DynamicSupervisor.init(strategy: :one_for_one, max_children: @max_rooms)
  end

  def start_room(room_id, opts) do
    child_spec = {Vesper.Voice.Room, [{:room_id, room_id} | opts]}

    case DynamicSupervisor.start_child(__MODULE__, child_spec) do
      {:ok, pid} -> {:ok, pid}
      {:error, {:already_started, pid}} -> {:ok, pid}
      error -> error
    end
  end

  def stop_room(room_id) do
    case Registry.lookup(Vesper.Voice.Registry, room_id) do
      [{pid, _}] -> DynamicSupervisor.terminate_child(__MODULE__, pid)
      [] -> :ok
    end
  end
end
