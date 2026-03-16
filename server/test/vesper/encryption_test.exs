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
  end

  describe "pending welcome storage" do
    test "accepts long key package references" do
      recipient = insert_user()
      sender = insert_user()
      long_key_package_ref = String.duplicate("A", 512)

      assert {:ok, welcome} =
               Encryption.store_pending_welcome(%{
                 recipient_id: recipient.id,
                 recipient_client_id: "client-a",
                 recipient_key_package_ref: long_key_package_ref,
                 group_id: Ecto.UUID.generate(),
                 welcome_data: <<1, 2, 3>>,
                 sender_id: sender.id
               })

      assert welcome.recipient_key_package_ref == long_key_package_ref
    end
  end

  describe "pending resync request scoping" do
    test "stores separate requests per requester client id" do
      requester = insert_user()
      group_id = Ecto.UUID.generate()

      assert {:ok, _request} =
               Encryption.store_pending_resync_request(%{
                 group_id: group_id,
                 request_id: "request-a",
                 requester_id: requester.id,
                 requester_username: requester.username,
                 requester_client_id: "client-a"
               })

      assert {:ok, _request} =
               Encryption.store_pending_resync_request(%{
                 "group_id" => group_id,
                 "request_id" => "request-b",
                 "requester_id" => requester.id,
                 "requester_username" => requester.username,
                 "requester_client_id" => "client-b"
               })

      requests = Encryption.get_pending_resync_requests(group_id)

      assert Enum.map(requests, & &1.requester_client_id) == ["client-a", "client-b"]
      assert Enum.map(requests, & &1.request_id) == ["request-a", "request-b"]
    end
  end
end
