defmodule Vesper.Servers.PermissionsCache do
  @moduledoc """
  ETS-backed permissions cache with PubSub invalidation.

  Key: {user_id, server_id} → permissions bitfield (integer).

  Channel processes read directly from ETS on permission-gated actions
  (pin, unpin, @everyone mentions). Cache misses are populated via GenServer.

  Invalidation: when any role is created/updated/deleted or member roles change,
  the Servers context broadcasts on `"server:permissions:<server_id>"`.
  This GenServer receives that and wipes all entries for that server.
  The wipe is O(n) over the table but role changes are rare admin actions.
  """

  use GenServer

  require Logger

  @table :vesper_permissions_cache

  # --- Public API (direct ETS reads — no GenServer call on hot path) ---

  @doc """
  Get permissions for a user in a server. Reads directly from ETS.
  On cache miss, populates from DB via the GenServer.
  """
  def get(user_id, server_id) do
    case :ets.lookup(@table, {user_id, server_id}) do
      [{{^user_id, ^server_id}, permissions}] ->
        permissions

      [] ->
        GenServer.call(__MODULE__, {:populate, user_id, server_id})
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
    {:ok, %{}}
  end

  @impl true
  def handle_call({:populate, user_id, server_id}, _from, state) do
    # Subscribe lazily per server (idempotent — PubSub deduplicates)
    Phoenix.PubSub.subscribe(Vesper.PubSub, "server:permissions:#{server_id}")
    permissions = fetch_and_cache(user_id, server_id)
    {:reply, permissions, state}
  end

  @impl true
  def handle_info(:permissions_changed, state) do
    # This message doesn't carry server_id, handled via specific topic handler below
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

  @impl true
  def handle_cast({:invalidate_server, server_id}, state) do
    :ets.match_delete(@table, {{:_, server_id}, :_})
    {:noreply, state}
  end

  # --- Private ---

  defp fetch_and_cache(user_id, server_id) do
    permissions = Vesper.Servers.get_user_permissions(user_id, server_id)
    :ets.insert(@table, {{user_id, server_id}, permissions})
    permissions
  end
end
