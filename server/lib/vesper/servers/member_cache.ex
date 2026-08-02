defmodule Vesper.Servers.MemberCache do
  @moduledoc """
  ETS-backed member ID cache with PubSub invalidation.

  Uses a :public ETS table with read_concurrency so channel processes
  can do direct :ets.lookup without copying data through this GenServer.
  This GenServer only handles writes (cache population and invalidation).

  Member IDs are stored as MapSets for O(1) membership checks and removal.
  The entire cache is swept every hour to prevent unbounded growth from
  deleted servers whose PubSub events were missed.
  """

  use GenServer

  @table :vesper_member_cache
  @sweep_interval :timer.hours(1)

  # --- Public API (direct ETS reads — no GenServer call on hot path) ---

  def get_member_ids(server_id) do
    case :ets.lookup(@table, server_id) do
      [{^server_id, member_ids}] ->
        member_ids

      [] ->
        :telemetry.execute([:vesper, :member_cache, :miss], %{count: 1}, %{server_id: server_id})
        GenServer.call(__MODULE__, {:populate, server_id})
    end
  end

  def invalidate(server_id) do
    GenServer.cast(__MODULE__, {:invalidate, server_id})
  end

  # --- GenServer ---

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, [], name: __MODULE__)
  end

  @impl true
  def init([]) do
    :ets.new(@table, [:set, :public, :named_table, read_concurrency: true])
    schedule_sweep()
    {:ok, %{}}
  end

  @impl true
  def handle_call({:populate, server_id}, _from, state) do
    Phoenix.PubSub.subscribe(Vesper.PubSub, "server:members:#{server_id}")
    member_ids = fetch_and_cache(server_id)
    {:reply, member_ids, state}
  end

  @impl true
  def handle_info({:member_joined, server_id, user_id}, state) do
    case :ets.lookup(@table, server_id) do
      [{^server_id, member_ids}] ->
        :ets.insert(@table, {server_id, MapSet.put(member_ids, user_id)})

      [] ->
        :ok
    end

    {:noreply, state}
  end

  @impl true
  def handle_info({:member_left, server_id, user_id}, state) do
    case :ets.lookup(@table, server_id) do
      [{^server_id, member_ids}] ->
        :ets.insert(@table, {server_id, MapSet.delete(member_ids, user_id)})

      [] ->
        :ok
    end

    {:noreply, state}
  end

  def handle_info(:sweep, state) do
    :ets.delete_all_objects(@table)
    schedule_sweep()
    {:noreply, state}
  end

  @impl true
  def handle_info(_msg, state) do
    {:noreply, state}
  end

  @impl true
  def handle_cast({:invalidate, server_id}, state) do
    :ets.delete(@table, server_id)
    {:noreply, state}
  end

  # --- Private ---

  defp schedule_sweep do
    Process.send_after(self(), :sweep, @sweep_interval)
  end

  defp fetch_and_cache(server_id) do
    member_ids = Vesper.Servers.list_member_ids(server_id) |> MapSet.new()
    :ets.insert(@table, {server_id, member_ids})
    member_ids
  end
end
