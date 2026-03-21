defmodule Vesper.EncryptionTest do
  use Vesper.DataCase, async: true

  import Ecto.Query

  alias Vesper.Encryption
  alias Vesper.Encryption.KeyPackage

  describe "key package scoping" do
    test "fetches the newest package when no client id is provided" do
      user = insert_user()

      older_package = <<1, 2, 3>>
      newer_package = <<4, 5, 6>>
      older_time = ~U[2026-03-16 10:00:00Z]
      newer_time = ~U[2026-03-16 10:00:01Z]

      Encryption.upload_key_packages(user.id, "client-a", [older_package])
      Encryption.upload_key_packages(user.id, "client-b", [newer_package])

      Repo.update_all(
        from(kp in KeyPackage,
          where: kp.user_id == ^user.id and kp.client_id == "client-a"
        ),
        set: [inserted_at: older_time]
      )

      Repo.update_all(
        from(kp in KeyPackage,
          where: kp.user_id == ^user.id and kp.client_id == "client-b"
        ),
        set: [inserted_at: newer_time]
      )

      assert Encryption.fetch_and_consume_key_package(user.id) == newer_package
      assert Encryption.count_key_packages(user.id, "client-a") == 1
      assert Encryption.count_key_packages(user.id, "client-b") == 0
    end

    test "only purges packages for the requested client id" do
      user = insert_user()

      Encryption.upload_key_packages(user.id, "client-a", [<<1>>])
      Encryption.upload_key_packages(user.id, "client-b", [<<2>>, <<3>>])

      assert {2, nil} = Encryption.purge_key_packages(user.id, "client-b")
      assert Encryption.count_key_packages(user.id, "client-a") == 1
      assert Encryption.count_key_packages(user.id, "client-b") == 0
    end

    test "consume_own_key_package marks the matching package as consumed" do
      user = insert_user()
      pkg_data = <<7, 8, 9>>

      Encryption.upload_key_packages(user.id, "client-a", [pkg_data])
      assert Encryption.count_key_packages(user.id, "client-a") == 1

      assert :ok = Encryption.consume_own_key_package(user.id, "client-a", pkg_data)
      assert Encryption.count_key_packages(user.id, "client-a") == 0
    end

    test "consume_own_key_package returns error for unknown package" do
      user = insert_user()

      assert {:error, :not_found} =
               Encryption.consume_own_key_package(user.id, "client-a", <<99>>)
    end

    test "purge_consumed_key_packages removes old consumed packages" do
      user = insert_user()

      Encryption.upload_key_packages(user.id, "client-a", [<<1>>, <<2>>])

      # Consume one
      Encryption.fetch_and_consume_key_package(user.id, "client-a")

      # Backdate the consumed package
      old_time = DateTime.utc_now() |> DateTime.add(-48 * 3600, :second) |> DateTime.truncate(:second)

      Repo.update_all(
        from(kp in KeyPackage,
          where: kp.user_id == ^user.id and kp.consumed == true
        ),
        set: [inserted_at: old_time]
      )

      {purged, _} = Encryption.purge_consumed_key_packages(24)
      assert purged == 1

      # Unconsumed package should still be there
      assert Encryption.count_key_packages(user.id, "client-a") == 1
    end
  end
end
