defmodule Vesper.Servers.PermissionsCache do
  @moduledoc """
  ETS-backed permissions cache with PubSub invalidation.

  Key: {user_id, server_id} -> permissions bitfield (integer).

  Channel processes read directly from ETS on permission-gated actions
  (pin, unpin, @everyone mentions). Cache misses are populated directly
  from DB by the calling process (no GenServer serialization).

  Invalidation: when any role is created/updated/deleted or member roles change,
  the Servers context broadcasts on `"server:permissions:<server_id>"`.
  This GenServer receives that and wipes all entries for that server.
  """

  use GenServer

  require Logger

  @table :vesper_permissions_cache

  # --- Public API (direct ETS reads — no GenServer call on hot path) ---

  @doc """
  Get permissions for a user in a server. Reads directly from ETS.
  On cache miss, populates from DB directly (no GenServer bottleneck).
  """
  def get(user_id, server_id) do
    if sandbox_pool?() do
      Vesper.Servers.get_user_permissions(user_id, server_id)
    else
      case :ets.lookup(@table, {user_id, server_id}) do
        [{{^user_id, ^server_id}, permissions}] ->
          permissions

        [] ->
          # Direct DB read + ETS write from caller process.
          # Avoids GenServer serialization on cold start.
          permissions = Vesper.Servers.get_user_permissions(user_id, server_id)
          :ets.insert(@table, {{user_id, server_id}, permissions})

          # Ensure PubSub subscription for this server (async, idempotent)
          GenServer.cast(__MODULE__, {:ensure_subscribed, server_id})

          permissions
      end
    end
  end

  @doc """
  Check if a user has a specific permission. Convenience wrapper.
  """
  def has_permission?(user_id, server_id, permission) do
    perms = get(user_id, server_id)
    Vesper.Servers.Permissions.has_permission?(perms, permission)
  end

  @doc """
  Invalidate all cached permissions for a server.
  Called when roles change — rare admin action, OK to be O(n).
  """
  def invalidate_server(server_id) do
    GenServer.cast(__MODULE__, {:invalidate_server, server_id})
  end

  # --- GenServer ---

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, [], name: __MODULE__)
  end

  @impl true
  def init([]) do
    :ets.new(@table, [:set, :public, :named_table, read_concurrency: true])
    {:ok, %{subscribed: MapSet.new()}}
  end

  @impl true
  def handle_cast({:ensure_subscribed, server_id}, %{subscribed: subs} = state) do
    if MapSet.member?(subs, server_id) do
      {:noreply, state}
    else
      Phoenix.PubSub.subscribe(Vesper.PubSub, "server:permissions:#{server_id}")
      {:noreply, %{state | subscribed: MapSet.put(subs, server_id)}}
    end
  end

  @impl true
  def handle_cast({:invalidate_server, server_id}, state) do
    :ets.match_delete(@table, {{:_, server_id}, :_})
    {:noreply, state}
  end

  @impl true
  def handle_info({:permissions_changed, server_id}, state) do
    :ets.match_delete(@table, {{:_, server_id}, :_})
    {:noreply, state}
  end

  @impl true
  def handle_info(_msg, state) do
    {:noreply, state}
  end

  # --- Private ---

  defp sandbox_pool? do
    Application.get_env(:vesper, Vesper.Repo, [])[:pool] == Ecto.Adapters.SQL.Sandbox
  end
end
