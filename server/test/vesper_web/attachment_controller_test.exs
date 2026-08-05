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

  test "stream upload stores an opaque body without multipart buffering", %{conn: _conn} do
    user = insert_user()
    ciphertext = :crypto.strong_rand_bytes(2_097_181)
    filename = "large archive.zip"

    conn =
      :post
      |> build_conn("/api/v1/attachments/stream", ciphertext)
      |> put_req_header("content-type", "application/octet-stream")
      |> put_req_header("content-length", Integer.to_string(byte_size(ciphertext)))
      |> put_req_header("x-vesper-filename-b64", Base.encode64(filename))
      |> put_req_header("x-vesper-content-type", "application/zip")
      |> assign(:current_user, user)
      |> AttachmentController.create_stream(%{})

    assert %{
             "attachment" => %{
               "id" => attachment_id,
               "filename" => ^filename,
               "content_type" => "application/zip",
               "size_bytes" => size,
               "encrypted" => true
             }
           } = json_response(conn, 201)

    assert size == byte_size(ciphertext)
    attachment = Repo.get!(Attachment, attachment_id)
    assert File.read!(FileStorage.get_path(attachment.storage_key)) == ciphertext
    on_exit(fn -> FileStorage.delete(attachment.storage_key) end)
  end

  test "stream upload rejects a body that does not match its declared length", %{conn: _conn} do
    user = insert_user()

    conn =
      :post
      |> build_conn("/api/v1/attachments/stream", "too many bytes")
      |> put_req_header("content-type", "application/octet-stream")
      |> put_req_header("content-length", "3")
      |> put_req_header("x-vesper-filename-b64", Base.encode64("mismatch.bin"))
      |> assign(:current_user, user)
      |> AttachmentController.create_stream(%{})

    assert json_response(conn, 413) == %{"error" => "file too large"}
    assert Repo.aggregate(Attachment, :count) == 0
  end

  test "expired attachments stop consuming upload quota before cleanup runs", %{conn: conn} do
    user = insert_user()
    quota = Application.fetch_env!(:vesper, :max_upload_bytes_per_user)

    %Attachment{}
    |> Attachment.changeset(%{
      filename: "expired-quota.bin",
      size_bytes: quota,
      storage_key: "expired-quota-#{Ecto.UUID.generate()}",
      uploader_id: user.id,
      encrypted: true,
      expires_at: DateTime.utc_now() |> DateTime.add(-1, :second) |> DateTime.truncate(:second)
    })
    |> Repo.insert!()

    path = temporary_upload!("new active upload")

    conn =
      conn
      |> assign(:current_user, user)
      |> AttachmentController.create(%{
        "file" => %Plug.Upload{
          path: path,
          filename: "active.txt",
          content_type: "text/plain"
        }
      })

    assert %{"attachment" => %{"id" => attachment_id}} = json_response(conn, 201)
    attachment = Repo.get!(Attachment, attachment_id)
    on_exit(fn -> FileStorage.delete(attachment.storage_key) end)
  end

  test "channel attachment access ends when current membership is revoked", %{conn: conn} do
    owner = insert_user()
    member = insert_user()
    server = insert_server(owner)
    channel = insert_channel(server)
    insert_membership(member, server)
    message = insert_message(member, channel)

    {attachment, storage_key} =
      insert_attachment_with_file(message, uploader_id: member.id, file_content: "member bytes")

    on_exit(fn -> FileStorage.delete(storage_key) end)

    authorized_conn =
      conn
      |> assign(:current_user, member)
      |> AttachmentController.show(%{"id" => attachment.id})

    assert authorized_conn.status == 200
    assert authorized_conn.resp_body == "member bytes"

    assert {:ok, _membership} = Vesper.Servers.kick_member(server.id, member.id)

    revoked_conn =
      build_conn()
      |> assign(:current_user, member)
      |> AttachmentController.show(%{"id" => attachment.id})

    assert json_response(revoked_conn, 403) == %{"error" => "access denied"}
  end

  test "an authorized uploader cannot read an attachment after its expiry", %{conn: conn} do
    user = insert_user()
    path = temporary_upload!("expired encrypted bytes")
    {:ok, storage_key} = FileStorage.store(path, "expired.bin")
    on_exit(fn -> FileStorage.delete(storage_key) end)

    attachment =
      %Attachment{}
      |> Attachment.changeset(%{
        filename: "expired.bin",
        content_type: "application/octet-stream",
        size_bytes: 23,
        storage_key: storage_key,
        encrypted: true,
        uploader_id: user.id,
        expires_at: DateTime.utc_now() |> DateTime.add(-1, :second) |> DateTime.truncate(:second)
      })
      |> Repo.insert!()

    conn =
      conn
      |> assign(:current_user, user)
      |> AttachmentController.show(%{"id" => attachment.id})

    assert json_response(conn, 410) == %{"error" => "attachment expired"}
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

  test "authorized attachment reads support single byte ranges without metadata disclosure", %{
    conn: conn
  } do
    user = insert_user()
    server = insert_server(user)
    insert_membership(user, server)
    channel = insert_channel(server)
    message = insert_message(user, channel)

    {attachment, storage_key} =
      insert_attachment_with_file(message,
        uploader_id: user.id,
        file_content: "0123456789",
        filename: "secret-name.txt",
        content_type: "text/plain",
        encrypted: true
      )

    on_exit(fn -> FileStorage.delete(storage_key) end)
    etag = ~s("sha256-#{storage_key}")

    full =
      conn
      |> assign(:current_user, user)
      |> AttachmentController.show(%{"id" => attachment.id})

    assert full.status == 200
    assert full.resp_body == "0123456789"
    assert get_resp_header(full, "accept-ranges") == ["bytes"]
    assert get_resp_header(full, "etag") == [etag]
    assert get_resp_header(full, "cache-control") == ["private, no-store, no-transform"]
    assert get_resp_header(full, "x-content-type-options") == ["nosniff"]
    assert get_resp_header(full, "content-length") == ["10"]
    assert get_resp_header(full, "content-type") == ["application/octet-stream; charset=utf-8"]

    assert get_resp_header(full, "content-disposition") == [
             ~s(attachment; filename="#{attachment.id}")
           ]

    for {range, expected_body, expected_content_range} <- [
          {"bytes=2-5", "2345", "bytes 2-5/10"},
          {"bytes=7-", "789", "bytes 7-9/10"},
          {"bytes=-3", "789", "bytes 7-9/10"},
          {"bytes=8-99", "89", "bytes 8-9/10"}
        ] do
      ranged =
        build_conn()
        |> put_req_header("range", range)
        |> assign(:current_user, user)
        |> AttachmentController.show(%{"id" => attachment.id})

      assert ranged.status == 206
      assert ranged.resp_body == expected_body
      assert get_resp_header(ranged, "content-range") == [expected_content_range]

      assert get_resp_header(ranged, "content-length") == [
               Integer.to_string(byte_size(expected_body))
             ]

      assert get_resp_header(ranged, "etag") == [etag]
    end

    head =
      :head
      |> build_conn("/api/v1/attachments/#{attachment.id}")
      |> put_req_header("range", "bytes=2-5")
      |> Plug.Head.call([])
      |> assign(:current_user, user)
      |> AttachmentController.show(%{"id" => attachment.id})

    assert head.status == 206
    assert head.resp_body == ""
    assert get_resp_header(head, "content-range") == ["bytes 2-5/10"]
    assert get_resp_header(head, "content-length") == ["4"]
  end

  test "attachment range validation and If-Range are deterministic", %{conn: conn} do
    user = insert_user()
    server = insert_server(user)
    insert_membership(user, server)
    channel = insert_channel(server)
    message = insert_message(user, channel)

    {attachment, storage_key} =
      insert_attachment_with_file(message,
        uploader_id: user.id,
        file_content: "abcdefghij",
        encrypted: true
      )

    on_exit(fn -> FileStorage.delete(storage_key) end)
    etag = ~s("sha256-#{storage_key}")

    matching =
      conn
      |> put_req_header("range", "bytes=1-3")
      |> put_req_header("if-range", etag)
      |> assign(:current_user, user)
      |> AttachmentController.show(%{"id" => attachment.id})

    assert matching.status == 206
    assert matching.resp_body == "bcd"

    mismatching =
      build_conn()
      |> put_req_header("range", "bytes=1-3")
      |> put_req_header("if-range", ~s("other"))
      |> assign(:current_user, user)
      |> AttachmentController.show(%{"id" => attachment.id})

    assert mismatching.status == 200
    assert mismatching.resp_body == "abcdefghij"
    assert get_resp_header(mismatching, "content-range") == []

    multi_range =
      build_conn()
      |> put_req_header("range", "bytes=0-1,4-5")
      |> assign(:current_user, user)
      |> AttachmentController.show(%{"id" => attachment.id})

    assert multi_range.status == 200
    assert multi_range.resp_body == "abcdefghij"

    for invalid <- ["bytes=20-30", "bytes=5-4", "bytes=-0", "bytes=nope"] do
      response =
        build_conn()
        |> put_req_header("range", invalid)
        |> assign(:current_user, user)
        |> AttachmentController.show(%{"id" => attachment.id})

      assert response.status == 416
      assert response.resp_body == ""
      assert get_resp_header(response, "content-range") == ["bytes */10"]
      assert get_resp_header(response, "content-length") == ["0"]
    end
  end

  test "range metadata is not exposed after access is revoked", %{conn: conn} do
    owner = insert_user()
    member = insert_user()
    server = insert_server(owner)
    channel = insert_channel(server)
    insert_membership(member, server)
    message = insert_message(owner, channel)

    {attachment, storage_key} =
      insert_attachment_with_file(message, uploader_id: owner.id, file_content: "private bytes")

    on_exit(fn -> FileStorage.delete(storage_key) end)
    assert {:ok, _membership} = Vesper.Servers.kick_member(server.id, member.id)

    denied =
      conn
      |> put_req_header("range", "bytes=0-3")
      |> assign(:current_user, member)
      |> AttachmentController.show(%{"id" => attachment.id})

    assert json_response(denied, 403) == %{"error" => "access denied"}

    for header <- ["accept-ranges", "content-range", "content-length", "etag"] do
      assert get_resp_header(denied, header) == []
    end
  end

  defp temporary_upload!(contents) do
    path = Path.join(System.tmp_dir!(), "vesper-upload-#{Ecto.UUID.generate()}")
    File.write!(path, contents)
    on_exit(fn -> File.rm(path) end)
    path
  end
end
