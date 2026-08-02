defmodule Vesper.InputValidationTest do
  use Vesper.DataCase, async: true

  alias Vesper.Chat
  alias Vesper.Chat.{Attachment, DmConversation, Message}
  alias Vesper.Repo
  alias Vesper.Servers

  test "attachment metadata rejects oversized, control-character, and negative fields" do
    changeset =
      Attachment.changeset(%Attachment{}, %{
        filename: String.duplicate("a", 256) <> "\n",
        content_type: "text/plain\r\nX-Injected: true",
        size_bytes: -1,
        storage_key: "key"
      })

    refute changeset.valid?
    assert "should be at most 255 character(s)" in errors_on(changeset).filename
    assert "must not contain control characters" in errors_on(changeset).filename
    assert "must not contain control characters" in errors_on(changeset).content_type
    assert "must be greater than or equal to 0" in errors_on(changeset).size_bytes
  end

  test "DM names and participant counts are bounded" do
    invalid_name =
      DmConversation.changeset(%DmConversation{}, %{
        type: "group",
        name: "unsafe\u0000name"
      })

    refute invalid_name.valid?
    assert "must not contain control characters" in errors_on(invalid_name).name

    creator = insert_user()
    too_many = Enum.map(1..100, fn _index -> Ecto.UUID.generate() end)

    assert {:error, :too_many_participants} =
             Chat.create_conversation(creator.id, too_many)

    assert {:error, :participant_required} = Chat.create_conversation(creator.id, [])
  end

  test "a sender cannot claim another user's unlinked attachment" do
    uploader = insert_user()
    sender = insert_user()
    {:ok, server} = Servers.create_server(sender, %{name: "Attachment ownership"})
    channel = Enum.find(server.channels, &(&1.type == "text"))

    attachment =
      %Attachment{}
      |> Attachment.changeset(%{
        filename: "private.bin",
        content_type: "application/octet-stream",
        size_bytes: 3,
        storage_key: "private-storage-key",
        uploader_id: uploader.id
      })
      |> Repo.insert!()

    assert {:error, :invalid_attachment_ids} =
             Chat.create_message(
               %{
                 ciphertext: <<1, 2, 3>>,
                 mls_epoch: 0,
                 encryption_scheme: "mls",
                 channel_id: channel.id,
                 sender_id: sender.id
               },
               attachment_ids: [attachment.id]
             )

    assert Repo.get!(Attachment, attachment.id).message_id == nil
    assert Repo.aggregate(Message, :count) == 0
  end

  test "message attachment lists are bounded and UUID-validated" do
    user = insert_user()
    {:ok, server} = Servers.create_server(user, %{name: "Attachment limits"})
    channel = Enum.find(server.channels, &(&1.type == "text"))

    attrs = %{
      ciphertext: <<1>>,
      mls_epoch: 0,
      encryption_scheme: "mls",
      channel_id: channel.id,
      sender_id: user.id
    }

    assert {:error, :too_many_attachments} =
             Chat.create_message(attrs,
               attachment_ids: Enum.map(1..11, fn _ -> Ecto.UUID.generate() end)
             )

    assert {:error, :invalid_attachment_ids} =
             Chat.create_message(attrs, attachment_ids: ["not-a-uuid"])
  end

  defp errors_on(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {message, options} ->
      Enum.reduce(options, message, fn {key, value}, rendered ->
        String.replace(rendered, "%{#{key}}", to_string(value))
      end)
    end)
  end
end
