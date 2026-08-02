defmodule Vesper.MigratorTest do
  use Vesper.DataCase, async: false

  setup do
    previous = Application.get_env(:vesper, :migration_status)

    on_exit(fn ->
      if is_nil(previous) do
        Application.delete_env(:vesper, :migration_status)
      else
        Application.put_env(:vesper, :migration_status, previous)
      end
    end)
  end

  test "startup does not return until migrations have completed" do
    Application.put_env(:vesper, :migration_status, :pending)

    assert {:ok, pid} = Vesper.Migrator.start_link([])
    assert Vesper.Migrator.status() == :ok

    GenServer.stop(pid)
  end

  test "disabled startup migrations are checked rather than assumed healthy" do
    Application.put_env(:vesper, :migration_status, :unchecked)
    assert Vesper.Migrator.status() == :ok

    %{rows: [[latest_version]]} =
      Ecto.Adapters.SQL.query!(
        Vesper.Repo,
        "SELECT MAX(version) FROM schema_migrations",
        []
      )

    Ecto.Adapters.SQL.query!(
      Vesper.Repo,
      "DELETE FROM schema_migrations WHERE version = $1",
      [latest_version]
    )

    assert Vesper.Migrator.status() == :pending
  end
end
