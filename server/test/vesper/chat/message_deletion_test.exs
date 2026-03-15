defmodule Vesper.Chat.MessageDeletionTest do
  @moduledoc """
  Regression tests for message deletion with attachment file cleanup.

  Verifies that Chat.delete_message/1 removes orphaned files from disk
  while preserving dedup-shared blobs that still have other references.
  """

  use Vesper.DataCase

  alias Vesper.Chat
  alias Vesper.Chat.{Attachment, FileStorage}

  import Ecto.Query

  setup do
    user = insert_user()
    server = insert_server(user)
    channel = insert_channel(server)
    %{user: user, channel: channel}
  end

  describe "delete_message/1 attachment cleanup" do
    test "deletes file from disk when message with attachment is deleted", %{
      user: user,
      channel: channel
    } do
      message = insert_message(user, channel)
      {_attachment, storage_key} = insert_attachment_with_file(message)

      # File exists before deletion
      assert File.exists?(FileStorage.get_path(storage_key))

      # Delete the message
      assert {:ok, _} = Chat.delete_message(message)

      # File is gone
      refute File.exists?(FileStorage.get_path(storage_key))

      # Attachment row is gone (cascade)
      assert Repo.aggregate(from(a in Attachment, where: a.storage_key == ^storage_key), :count) == 0
    end

    test "preserves file when another message still references the same blob", %{
      user: user,
      channel: channel
    } do
      shared_key = :crypto.strong_rand_bytes(32) |> Base.encode16(case: :lower)
      shared_content = "shared dedup content"

      msg1 = insert_message(user, channel)
      msg2 = insert_message(user, channel)

      {_a1, ^shared_key} =
        insert_attachment_with_file(msg1,
          storage_key: shared_key,
          file_content: shared_content
        )

      {_a2, ^shared_key} =
        insert_attachment_with_file(msg2,
          storage_key: shared_key,
          file_content: shared_content
        )

      # Two attachment rows reference the same blob
      assert Repo.aggregate(from(a in Attachment, where: a.storage_key == ^shared_key), :count) == 2

      # Delete the first message — file should survive
      assert {:ok, _} = Chat.delete_message(msg1)

      assert File.exists?(FileStorage.get_path(shared_key)),
             "File should still exist while another attachment references it"

      assert Repo.aggregate(from(a in Attachment, where: a.storage_key == ^shared_key), :count) == 1

      # Delete the second message — file should now be removed
      assert {:ok, _} = Chat.delete_message(msg2)

      refute File.exists?(FileStorage.get_path(shared_key)),
             "File should be deleted when no attachments reference it"

      assert Repo.aggregate(from(a in Attachment, where: a.storage_key == ^shared_key), :count) == 0
    end

    test "deletes multiple attachment files from a single message", %{
      user: user,
      channel: channel
    } do
      message = insert_message(user, channel)

      {_a1, key1} = insert_attachment_with_file(message, filename: "file1.txt")
      {_a2, key2} = insert_attachment_with_file(message, filename: "file2.txt")

      assert File.exists?(FileStorage.get_path(key1))
      assert File.exists?(FileStorage.get_path(key2))

      assert {:ok, _} = Chat.delete_message(message)

      refute File.exists?(FileStorage.get_path(key1))
      refute File.exists?(FileStorage.get_path(key2))
    end

    test "succeeds when message has no attachments", %{user: user, channel: channel} do
      message = insert_message(user, channel)

      assert {:ok, _} = Chat.delete_message(message)

      assert Repo.get(Chat.Message, message.id) == nil
    end

    test "returns the deleted message struct on success", %{user: user, channel: channel} do
      message = insert_message(user, channel)
      {_attachment, _key} = insert_attachment_with_file(message)

      assert {:ok, deleted} = Chat.delete_message(message)
      assert deleted.id == message.id
    end
  end
end
