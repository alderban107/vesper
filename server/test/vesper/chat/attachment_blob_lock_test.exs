defmodule Vesper.Chat.AttachmentBlobLockTest do
  use Vesper.DataCase, async: false

  alias Vesper.Chat.AttachmentBlobLock

  test "same-key publication and cleanup execute serially" do
    parent = self()
    storage_key = "blob-lock-#{Ecto.UUID.generate()}"

    first =
      Task.async(fn ->
        AttachmentBlobLock.with_lock(storage_key, fn ->
          send(parent, :first_entered)

          receive do
            :release_first -> :first_complete
          end
        end)
      end)

    assert_receive :first_entered, 1_000

    second =
      Task.async(fn ->
        AttachmentBlobLock.with_lock(storage_key, fn ->
          send(parent, :second_entered)
          :second_complete
        end)
      end)

    refute_receive :second_entered, 100
    send(first.pid, :release_first)
    assert {:ok, :first_complete} = Task.await(first)
    assert_receive :second_entered, 1_000
    assert {:ok, :second_complete} = Task.await(second)
  end
end
