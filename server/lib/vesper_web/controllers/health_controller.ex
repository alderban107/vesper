defmodule VesperWeb.HealthController do
  use VesperWeb, :controller

  def check(conn, _params) do
    migration_status = Vesper.Migrator.status()
    db_status = check_db()

    healthy = migration_status == :ok and db_status == :ok

    status = if healthy, do: :ok, else: :service_unavailable

    conn
    |> put_status(status)
    |> json(%{
      status: if(healthy, do: "ok", else: "error"),
      migrations: to_string(migration_status),
      database: to_string(db_status)
    })
  end

  defp check_db do
    Ecto.Adapters.SQL.query(Vesper.Repo, "SELECT 1")
    :ok
  rescue
    _ -> :unavailable
  end
end
