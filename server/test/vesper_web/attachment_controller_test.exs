defmodule VesperWeb.AttachmentControllerTest do
  use Vesper.ConnCase, async: true

  alias Vesper.Chat.{Attachment, FileStorage}
  alias VesperWeb.AttachmentController

  test "upload cannot pre-link an attachment to another sender's message", %{conn: conn} do
    owner = insert_user()
    attacker = insert_user()
    server = insert_server(owner)
    channel = insert_channel(server)
    insert_membership(attacker, server)
    message = insert_message(owner, channel)
    path = temporary_upload!("untrusted pre-link")

    conn =
      conn
      |> assign(:current_user, attacker)
      |> AttachmentController.create(%{
        "file" => %Plug.Upload{
          path: path,
          filename: "proof.txt",
          content_type: "text/plain"
        },
        "message_id" => message.id
      })

    assert %{"attachment" => %{"id" => attachment_id, "message_id" => nil}} =
             json_response(conn, 201)

    attachment = Repo.get!(Attachment, attachment_id)
    assert is_nil(attachment.message_id)
    assert attachment.uploader_id == attacker.id

    on_exit(fn -> FileStorage.delete(attachment.storage_key) end)
  end

  test "per-user storage quota is serialized and rejected files are removed", %{conn: conn} do
    user = insert_user()
    quota = Application.fetch_env!(:vesper, :max_upload_bytes_per_user)

    %Attachment{}
    |> Attachment.changeset(%{
      filename: "existing.bin",
      size_bytes: quota,
      storage_key: "quota-fixture-#{Ecto.UUID.generate()}",
      uploader_id: user.id,
      encrypted: true,
      expires_at: DateTime.utc_now() |> DateTime.add(3600) |> DateTime.truncate(:second)
    })
    |> Repo.insert!()

    contents = "quota rejection #{Ecto.UUID.generate()}"
    path = temporary_upload!(contents)
    expected_key = :crypto.hash(:sha256, contents) |> Base.encode16(case: :lower)

    conn =
      conn
      |> assign(:current_user, user)
      |> AttachmentController.create(%{
        "file" => %Plug.Upload{
          path: path,
          filename: "rejected.txt",
          content_type: "text/plain"
        }
      })

    assert json_response(conn, 413) == %{"error" => "upload quota exceeded"}
    assert Repo.aggregate(Attachment, :count) == 1
    refute File.exists?(FileStorage.get_path(expected_key))
  end

  test "unlinked legacy attachment without an owner fails closed", %{conn: conn} do
    user = insert_user()
    path = temporary_upload!("legacy orphan")
    {:ok, storage_key} = FileStorage.store(path, "legacy.txt")
    on_exit(fn -> FileStorage.delete(storage_key) end)

    attachment =
      %Attachment{}
      |> Attachment.changeset(%{
        filename: "legacy.txt",
        content_type: "text/plain",
        size_bytes: 13,
        storage_key: storage_key,
        encrypted: true,
        expires_at: DateTime.utc_now() |> DateTime.add(3600) |> DateTime.truncate(:second)
      })
      |> Repo.insert!()

    conn =
      conn
      |> assign(:current_user, user)
      |> AttachmentController.show(%{"id" => attachment.id})

    assert json_response(conn, 403) == %{"error" => "access denied"}
  end

  defp temporary_upload!(contents) do
    path = Path.join(System.tmp_dir!(), "vesper-upload-#{Ecto.UUID.generate()}")
    File.write!(path, contents)
    on_exit(fn -> File.rm(path) end)
    path
  end
end
