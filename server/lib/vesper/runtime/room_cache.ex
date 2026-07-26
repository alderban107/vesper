defmodule Vesper.Runtime.RoomCache do
  use GenServer

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, [], name: __MODULE__)
  end

  @impl true
  def init([]) do
    :ok = Vesper.Runtime.init_room_cache()

    if Application.get_env(:vesper, :warm_room_cache_on_start, true) do
      send(self(), :warm)
    end

    {:ok, %{}}
  end

  @impl true
  def handle_info(:warm, state) do
    :ok = Vesper.Runtime.warm_room_cache()
    {:noreply, state}
  end
end
