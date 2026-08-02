defmodule Vesper.Servers.AttachmentCleanupTest do
  use Vesper.DataCase, async: true

  alias Vesper.Chat.FileStorage
  alias Vesper.Servers

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
end
