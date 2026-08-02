defmodule Vesper.RecoveryPackageConcurrencyTest do
  use Vesper.DataCase, async: false

  alias Ecto.Adapters.SQL.Sandbox
  alias Vesper.Encryption
  alias Vesper.Encryption.ScopeRecoveryPackage
  alias Vesper.Repo

  test "concurrent first writers use separate database connections and keep the newest cursor" do
    owner = Sandbox.unboxed_run(Repo, &insert_user/0)
    scope_id = Ecto.UUID.generate()
    parent = self()
    start_ref = make_ref()
    expires_at = DateTime.utc_now() |> DateTime.add(3600, :second) |> DateTime.truncate(:second)

    try do
      # Do not hold a parent connection while the six writers wait at the
      # barrier. The smallest supported CI pool has eight slots, leaving room
      # for the repository's supervised background processes.
      tasks =
        for cursor <- 1..6 do
          Task.async(fn ->
            Sandbox.unboxed_run(Repo, fn ->
              send(parent, {:recovery_package_writer_ready, self()})

              receive do
                {:write_recovery_package, ^start_ref} -> :ok
              end

              %{rows: [[backend_pid]]} = Repo.query!("SELECT pg_backend_pid()")

              result =
                Encryption.upsert_scope_recovery_package(%{
                  owner_id: owner.id,
                  scope_id: scope_id,
                  ciphertext: "opaque-#{cursor}",
                  nonce: :crypto.strong_rand_bytes(12),
                  membership_generation: 1,
                  last_event_seq: cursor,
                  schema_version: 1,
                  byte_size: 32,
                  expires_at: expires_at
                })

              {backend_pid, result}
            end)
          end)
        end

      for _ <- tasks do
        assert_receive {:recovery_package_writer_ready, _pid}, 5_000
      end

      Enum.each(tasks, fn task ->
        send(task.pid, {:write_recovery_package, start_ref})
      end)

      results = Enum.map(tasks, &Task.await(&1, 10_000))
      assert results |> Enum.map(&elem(&1, 0)) |> Enum.uniq() |> length() == 6
      assert Enum.all?(results, &match?({_backend_pid, {:ok, _}}, &1))

      Sandbox.unboxed_run(Repo, fn ->
        assert Repo.aggregate(ScopeRecoveryPackage, :count, :id) == 1

        assert %{last_event_seq: 6, ciphertext: "opaque-6"} =
                 Encryption.get_scope_recovery_package(owner.id, scope_id)
      end)
    after
      Sandbox.unboxed_run(Repo, fn -> Repo.delete!(owner) end)
    end
  end
end
