defmodule Vesper.Application do
  # See https://hexdocs.pm/elixir/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children =
      [Vesper.Repo] ++
        migration_children() ++
        [
          VesperWeb.Telemetry,
          Vesper.Runtime.RoomCache,
          {DNSCluster, query: Application.get_env(:vesper, :dns_cluster_query) || :ignore},
          {Phoenix.PubSub, name: Vesper.PubSub, pool_size: System.schedulers_online()},
          {Oban, Application.fetch_env!(:vesper, Oban)},
          {Task.Supervisor, name: Vesper.NotificationSupervisor, max_children: 500},
          {Task.Supervisor, name: Vesper.Voice.CleanupSupervisor, max_children: 100},
          Vesper.Servers.MemberCache,
          Vesper.Servers.PermissionsCache,
          {Registry, keys: :unique, name: Vesper.Voice.Registry},
          {Vesper.Voice.RoomSupervisor, []},
          VesperWeb.Presence,
          VesperWeb.Endpoint
        ]

    # See https://hexdocs.pm/elixir/Supervisor.html
    # for other strategies and supported options
    opts = [strategy: :one_for_one, name: Vesper.Supervisor]
    Supervisor.start_link(children, opts)
  end

  defp migration_children do
    if Application.get_env(:vesper, :run_migrations_on_start, true) do
      [Vesper.Migrator]
    else
      # A separate migration job is not evidence that this database is current.
      # Health performs a read-only pending-version check in this mode.
      Application.put_env(:vesper, :migration_status, :unchecked)
      []
    end
  end

  # Tell Phoenix to update the endpoint configuration
  # whenever the application is updated.
  @impl true
  def config_change(changed, _new, removed) do
    VesperWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
