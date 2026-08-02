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
    case Application.get_env(:vesper, :migration_status, :pending) do
      :unchecked -> checked_schema_status()
      status -> status
    end
  end

  defp checked_schema_status do
    path = Application.app_dir(:vesper, "priv/repo/migrations")

    if Enum.any?(
         Ecto.Migrator.migrations(Vesper.Repo, path, skip_table_creation: true),
         fn
           {:down, _version, _name} -> true
           _migration -> false
         end
       ) do
      :pending
    else
      :ok
    end
  rescue
    _ -> :failed
  end

  @impl true
  def init(_) do
    Application.put_env(:vesper, :migration_status, :running)

    case run_migrations() do
      :ok ->
        Application.put_env(:vesper, :migration_status, :ok)
        Logger.info("Migrations completed successfully")
        {:ok, %{}}

      {:error, reason} ->
        Application.put_env(:vesper, :migration_status, :failed)
        Logger.error("Migrations failed: #{inspect(reason)}")
        {:stop, {:migration_failed, reason}}
    end
  end

  defp run_migrations do
    path = Application.app_dir(:vesper, "priv/repo/migrations")

    Ecto.Migrator.run(Vesper.Repo, path, :up, all: true)

    :ok
  rescue
    e -> {:error, e}
  end
end
