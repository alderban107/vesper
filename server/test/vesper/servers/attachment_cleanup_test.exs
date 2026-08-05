defmodule Vesper.Servers.AttachmentCleanupTest do
  use Vesper.DataCase, async: true

  alias Vesper.Chat.{Attachment, FileStorage}
  alias Vesper.Repo
  alias Vesper.Servers
  alias Vesper.Workers.ExpireAttachmentBlobs

  test "deleting a channel removes its unreferenced attachment blob" do
    owner = insert_user()
    server = insert_server(owner)
    channel = insert_channel(server)
    message = insert_message(owner, channel)
    {_attachment, storage_key} = insert_attachment_with_file(message, uploader_id: owner.id)
    on_exit(fn -> FileStorage.delete(storage_key) end)

    assert File.exists?(FileStorage.get_path(storage_key))
    assert {:ok, _deleted} = Servers.delete_channel(channel)
    refute File.exists?(FileStorage.get_path(storage_key))
  end

  test "server cascade retains shared bytes until the final reference is deleted" do
    first_owner = insert_user()
    second_owner = insert_user()
    first_server = insert_server(first_owner)
    second_server = insert_server(second_owner)
    first_channel = insert_channel(first_server)
    second_channel = insert_channel(second_server)
    first_message = insert_message(first_owner, first_channel)
    second_message = insert_message(second_owner, second_channel)
    storage_key = :crypto.strong_rand_bytes(32) |> Base.encode16(case: :lower)

    insert_attachment_with_file(first_message,
      storage_key: storage_key,
      uploader_id: first_owner.id,
      file_content: "shared cascade bytes"
    )

    insert_attachment_with_file(second_message,
      storage_key: storage_key,
      uploader_id: second_owner.id,
      file_content: "shared cascade bytes"
    )

    on_exit(fn -> FileStorage.delete(storage_key) end)

    assert {:ok, _deleted} = Servers.delete_server(first_server)
    assert File.exists?(FileStorage.get_path(storage_key))

    assert {:ok, _deleted} = Servers.delete_server(second_server)
    refute File.exists?(FileStorage.get_path(storage_key))
  end

  test "expiry cleanup retains shared bytes until the final attachment expires" do
    owner = insert_user()
    server = insert_server(owner)
    channel = insert_channel(server)
    first_message = insert_message(owner, channel)
    second_message = insert_message(owner, channel)
    storage_key = :crypto.strong_rand_bytes(32) |> Base.encode16(case: :lower)
    past = DateTime.utc_now() |> DateTime.add(-1, :second) |> DateTime.truncate(:second)
    future = DateTime.utc_now() |> DateTime.add(3600, :second) |> DateTime.truncate(:second)

    {expired, _storage_key} =
      insert_attachment_with_file(first_message,
        storage_key: storage_key,
        uploader_id: owner.id,
        file_content: "shared expiry bytes",
        expires_at: past
      )

    {retained, _storage_key} =
      insert_attachment_with_file(second_message,
        storage_key: storage_key,
        uploader_id: owner.id,
        file_content: "shared expiry bytes",
        expires_at: future
      )

    on_exit(fn -> FileStorage.delete(storage_key) end)

    assert :ok = ExpireAttachmentBlobs.perform(%Oban.Job{args: %{}})
    refute Repo.get(Attachment, expired.id)
    assert Repo.get(Attachment, retained.id)
    assert File.exists?(FileStorage.get_path(storage_key))

    retained
    |> Ecto.Changeset.change(expires_at: past)
    |> Repo.update!()

    assert :ok = ExpireAttachmentBlobs.perform(%Oban.Job{args: %{}})
    refute Repo.get(Attachment, retained.id)
    refute File.exists?(FileStorage.get_path(storage_key))
  end

  test "orphan cleanup removes an unlinked upload after the grace period" do
    owner = insert_user()
    server = insert_server(owner)
    channel = insert_channel(server)
    message = insert_message(owner, channel)
    old = DateTime.utc_now() |> DateTime.add(-3601, :second) |> DateTime.truncate(:second)

    {orphan, storage_key} =
      insert_attachment_with_file(message,
        message_id: nil,
        uploader_id: owner.id,
        inserted_at: old
      )

    on_exit(fn -> FileStorage.delete(storage_key) end)

    assert :ok = ExpireAttachmentBlobs.perform(%Oban.Job{args: %{}})
    refute Repo.get(Attachment, orphan.id)
    refute File.exists?(FileStorage.get_path(storage_key))
  end
end
