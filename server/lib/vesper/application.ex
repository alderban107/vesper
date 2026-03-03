defmodule Vesper.Application do
  # See https://hexdocs.pm/elixir/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      VesperWeb.Telemetry,
      Vesper.Repo,
      Vesper.Migrator,
      {DNSCluster, query: Application.get_env(:vesper, :dns_cluster_query) || :ignore},
      {Phoenix.PubSub, name: Vesper.PubSub},
      {Oban, Application.fetch_env!(:vesper, Oban)},
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

  # Tell Phoenix to update the endpoint configuration
  # whenever the application is updated.
  @impl true
  def config_change(changed, _new, removed) do
    VesperWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
