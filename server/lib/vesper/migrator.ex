defmodule Vesper.Migrator do
  @moduledoc """
  Runs Ecto migrations on application startup and tracks their state
  so the health endpoint can report whether migrations are pending,
  complete, or failed.
  """
  use GenServer
  require Logger

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, [], name: __MODULE__)
  end

  def status do
    Application.get_env(:vesper, :migration_status, :pending)
  end

  @impl true
  def init(_) do
    Application.put_env(:vesper, :migration_status, :running)
    {:ok, %{}, {:continue, :migrate}}
  end

  @impl true
  def handle_continue(:migrate, state) do
    case run_migrations() do
      :ok ->
        Application.put_env(:vesper, :migration_status, :ok)
        Logger.info("Migrations completed successfully")

      {:error, reason} ->
        Application.put_env(:vesper, :migration_status, :failed)
        Logger.error("Migrations failed: #{inspect(reason)}")
    end

    {:noreply, state}
  end

  defp run_migrations do
    path = Application.app_dir(:vesper, "priv/repo/migrations")

    Ecto.Migrator.run(Vesper.Repo, path, :up, all: true)

    :ok
  rescue
    e -> {:error, e}
  end
end
