defmodule Vesper.MigratorTest do
  use Vesper.DataCase, async: false

  test "startup does not return until migrations have completed" do
    Application.put_env(:vesper, :migration_status, :pending)

    assert {:ok, pid} = Vesper.Migrator.start_link([])
    assert Vesper.Migrator.status() == :ok

    GenServer.stop(pid)
  end
end
