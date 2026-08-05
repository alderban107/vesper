defmodule VesperWeb.AttachmentController do
  use VesperWeb, :controller
  alias Vesper.Chat
  alias Vesper.Chat.{Attachment, AttachmentBlobLock, FileStorage}
  alias Vesper.Servers
  alias Vesper.Repo

  def create(conn, %{"file" => upload} = params) do
    user = conn.assigns.current_user
    max_size = FileStorage.max_upload_size()

    file_size =
      case File.stat(upload.path) do
        {:ok, %{size: size}} -> size
        _ -> 0
      end

    if file_size > max_size do
      conn |> put_status(:request_entity_too_large) |> json(%{error: "file too large"})
    else
      attrs =
        new_attachment_attrs(
          upload.filename,
          upload.content_type,
          file_size,
          params["encrypted"] == "true",
          user.id
        )

      persist_upload(conn, upload, attrs)
    end
  end

  def create(conn, _params) do
    conn |> put_status(:bad_request) |> json(%{error: "file is required"})
  end

  def create_stream(conn, _params) do
    user = conn.assigns.current_user
    max_size = Application.fetch_env!(:vesper, :max_upload_bytes_per_user)

    with {:ok, filename} <- decode_filename_header(conn),
         {:ok, content_type} <-
           single_header(conn, "x-vesper-content-type", "application/octet-stream"),
         {:ok, declared_size} <- content_length(conn),
         :ok <- validate_stream_size(declared_size, max_size),
         {:ok, conn, upload} <- spool_request_body(conn, filename, content_type, declared_size) do
      try do
        attrs =
          new_attachment_attrs(
            upload.filename,
            upload.content_type,
            upload.size,
            true,
            user.id
          )

        persist_upload(conn, upload, attrs)
      after
        File.rm(upload.path)
      end
    else
      {:error, :length_required} ->
        conn |> put_status(:length_required) |> json(%{error: "content length is required"})

      {:error, :file_too_large} ->
        conn |> put_status(:request_entity_too_large) |> json(%{error: "file too large"})

      {:error, :invalid_headers} ->
        conn |> put_status(:bad_request) |> json(%{error: "invalid attachment headers"})

      {:error, :size_mismatch, conn} ->
        conn |> put_status(:bad_request) |> json(%{error: "attachment size mismatch"})

      {:error, :file_too_large, conn} ->
        conn |> put_status(:request_entity_too_large) |> json(%{error: "file too large"})

      {:error, :read_failure, conn} ->
        conn |> put_status(:bad_request) |> json(%{error: "could not read attachment"})
    end
  end

  defp new_attachment_attrs(filename, content_type, size, encrypted, uploader_id) do
    expiry_days = Application.get_env(:vesper, :file_expiry_days, 30)

    expires_at =
      DateTime.utc_now()
      |> DateTime.add(expiry_days * 86_400, :second)
      |> DateTime.truncate(:second)

    %{
      filename: filename,
      content_type: content_type,
      size_bytes: size,
      storage_key: "pending-validation",
      encrypted: encrypted,
      expires_at: expires_at,
      uploader_id: uploader_id
    }
  end

  defp persist_upload(conn, upload, attrs) do
    # Uploads are always created unlinked. Message creation claims the
    # uploader-owned attachment IDs atomically; accepting message_id here
    # would let a caller mutate another sender's existing message.
    validation = Attachment.changeset(%Attachment{}, attrs)

    if validation.valid? do
      case store_upload_with_quota(upload, attrs) do
        {:ok, attachment} ->
          conn
          |> put_status(:created)
          |> json(%{attachment: attachment_json(attachment)})

        {:error, :upload_quota_exceeded} ->
          conn
          |> put_status(:request_entity_too_large)
          |> json(%{error: "upload quota exceeded"})

        {:error, :invalid_metadata} ->
          conn
          |> put_status(:unprocessable_entity)
          |> json(%{error: "could not save attachment"})

        {:error, :storage_failure} ->
          conn
          |> put_status(:internal_server_error)
          |> json(%{error: "could not store file"})
      end
    else
      conn
      |> put_status(:unprocessable_entity)
      |> json(%{error: "invalid attachment metadata"})
    end
  end

  defp decode_filename_header(conn) do
    with {:ok, encoded} <- single_header(conn, "x-vesper-filename-b64", nil),
         true <- is_binary(encoded),
         {:ok, filename} <- Base.decode64(encoded),
         true <- String.valid?(filename) do
      {:ok, filename}
    else
      _invalid -> {:error, :invalid_headers}
    end
  end

  defp single_header(conn, name, default) do
    case get_req_header(conn, name) do
      [] when not is_nil(default) -> {:ok, default}
      [value] when is_binary(value) -> {:ok, value}
      _missing_or_multiple -> {:error, :invalid_headers}
    end
  end

  defp content_length(conn) do
    case get_req_header(conn, "content-length") do
      [value] ->
        case Integer.parse(value) do
          {size, ""} when size >= 0 -> {:ok, size}
          _invalid -> {:error, :invalid_headers}
        end

      [] ->
        {:error, :length_required}

      _multiple ->
        {:error, :invalid_headers}
    end
  end

  defp validate_stream_size(size, max_size) when size <= max_size, do: :ok
  defp validate_stream_size(_size, _max_size), do: {:error, :file_too_large}

  defp spool_request_body(conn, filename, content_type, declared_size) do
    path = Path.join(System.tmp_dir!(), "vesper-stream-upload-#{Ecto.UUID.generate()}")

    case File.open(path, [:write, :binary, :exclusive]) do
      {:ok, io} ->
        result = read_request_body(conn, io, 0, declared_size)
        File.close(io)

        case result do
          {:ok, conn, ^declared_size} ->
            {:ok, conn,
             %{path: path, filename: filename, content_type: content_type, size: declared_size}}

          {:ok, conn, _different_size} ->
            File.rm(path)
            {:error, :size_mismatch, conn}

          {:error, reason, conn} ->
            File.rm(path)
            {:error, reason, conn}
        end

      {:error, _reason} ->
        {:error, :read_failure, conn}
    end
  end

  defp read_request_body(conn, io, received, declared_size) do
    case Plug.Conn.read_body(conn,
           length: 1_048_576,
           read_length: 1_048_576,
           read_timeout: 30_000
         ) do
      {:ok, bytes, conn} ->
        write_request_bytes(conn, io, bytes, received, declared_size, true)

      {:more, bytes, conn} ->
        case write_request_bytes(conn, io, bytes, received, declared_size, false) do
          {:more, conn, received} -> read_request_body(conn, io, received, declared_size)
          error -> error
        end

      {:error, _reason} ->
        {:error, :read_failure, conn}
    end
  end

  defp write_request_bytes(conn, io, bytes, received, declared_size, final?) do
    next_received = received + byte_size(bytes)

    cond do
      next_received > declared_size ->
        {:error, :file_too_large, conn}

      IO.binwrite(io, bytes) != :ok ->
        {:error, :read_failure, conn}

      final? ->
        {:ok, conn, next_received}

      true ->
        {:more, conn, next_received}
    end
  end

  defp store_upload_with_quota(upload, attrs) do
    case FileStorage.store(upload.path, upload.filename) do
      {:ok, storage_key} ->
        result =
          try do
            AttachmentBlobLock.with_lock(storage_key, fn ->
              # The first store discovers the backend key. Ensure it still
              # exists under the key lock without hashing a large upload twice;
              # concurrent rejection or expiry cleanup cannot then remove it
              # immediately before our row commits.
              case FileStorage.ensure_stored(upload.path, upload.filename, storage_key) do
                :ok -> :ok
                _error -> Repo.rollback(:storage_failure)
              end

              # Quota writes for one uploader are serialized inside the same
              # transaction as the attachment row.
              Ecto.Adapters.SQL.query!(
                Repo,
                "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
                ["attachment-uploader:" <> attrs.uploader_id]
              )

              %{rows: [[used_bytes]]} =
                Ecto.Adapters.SQL.query!(
                  Repo,
                  "SELECT COALESCE(SUM(size_bytes), 0)::bigint FROM attachments WHERE uploader_id::text = $1 AND (expires_at IS NULL OR expires_at > NOW())",
                  [attrs.uploader_id]
                )

              quota = Application.fetch_env!(:vesper, :max_upload_bytes_per_user)

              if used_bytes + attrs.size_bytes > quota do
                AttachmentBlobLock.delete_if_unreferenced_locked(storage_key)
                Repo.rollback(:upload_quota_exceeded)
              end

              attrs
              |> Map.put(:storage_key, storage_key)
              |> then(&Attachment.changeset(%Attachment{}, &1))
              |> Repo.insert()
              |> case do
                {:ok, attachment} ->
                  attachment

                {:error, _changeset} ->
                  AttachmentBlobLock.delete_if_unreferenced_locked(storage_key)
                  Repo.rollback(:invalid_metadata)
              end
            end)
          rescue
            error ->
              AttachmentBlobLock.delete_if_unreferenced(storage_key)
              reraise error, __STACKTRACE__
          end

        case result do
          {:ok, attachment} ->
            {:ok, attachment}

          {:error, reason} ->
            AttachmentBlobLock.delete_if_unreferenced(storage_key)
            {:error, reason}
        end

      {:error, _reason} ->
        {:error, :storage_failure}
    end
  end

  def show(conn, %{"id" => id}) do
    user = conn.assigns.current_user

    case Repo.get(Attachment, id) do
      nil ->
        conn |> put_status(:not_found) |> json(%{error: "not found"})

      attachment ->
        attachment = Repo.preload(attachment, :message)

        cond do
          not authorized_for_attachment?(user.id, attachment) ->
            conn |> put_status(:forbidden) |> json(%{error: "access denied"})

          attachment_expired?(attachment) ->
            conn |> put_status(:gone) |> json(%{error: "attachment expired"})

          true ->
            send_attachment(conn, attachment)
        end
    end
  end

  defp send_attachment(conn, attachment) do
    path = FileStorage.get_path(attachment.storage_key)

    case File.stat(path) do
      {:ok, %{type: :regular, size: size}} ->
        # For encrypted attachments, don't leak filename or content_type in HTTP
        # headers — the client decrypts metadata from the message.
        {resp_type, resp_filename} =
          if attachment.encrypted do
            {"application/octet-stream", attachment.id}
          else
            safe_filename = String.replace(attachment.filename, ~r/["\r\n\\]/, "_")
            {attachment.content_type || "application/octet-stream", safe_filename}
          end

        etag = ~s("sha256-#{attachment.storage_key}")

        conn =
          conn
          |> put_resp_content_type(resp_type)
          |> put_resp_header("content-disposition", ~s(attachment; filename="#{resp_filename}"))
          |> put_resp_header("accept-ranges", "bytes")
          |> put_resp_header("etag", etag)
          |> put_resp_header("cache-control", "private, no-store, no-transform")
          |> put_resp_header("x-content-type-options", "nosniff")

        case requested_byte_range(conn, size, etag) do
          :full ->
            conn
            |> put_resp_header("content-length", Integer.to_string(size))
            |> send_file(200, path)

          {:partial, first, last} ->
            length = last - first + 1

            conn
            |> put_resp_header("content-range", "bytes #{first}-#{last}/#{size}")
            |> put_resp_header("content-length", Integer.to_string(length))
            |> send_file(206, path, first, length)

          :unsatisfiable ->
            conn
            |> put_resp_header("content-range", "bytes */#{size}")
            |> put_resp_header("content-length", "0")
            |> send_resp(416, "")
        end

      _error ->
        conn |> put_status(:not_found) |> json(%{error: "file not found"})
    end
  end

  defp requested_byte_range(conn, size, etag) do
    case get_req_header(conn, "range") do
      [] ->
        :full

      [range] ->
        if if_range_matches?(conn, etag), do: parse_byte_range(range, size), else: :full

      _multiple_ranges ->
        :full
    end
  end

  defp if_range_matches?(conn, etag) do
    case get_req_header(conn, "if-range") do
      [] -> true
      [^etag] -> true
      _mismatch_or_multiple -> false
    end
  end

  defp parse_byte_range("bytes=" <> range, size) do
    if String.contains?(range, ",") do
      :full
    else
      case Regex.run(~r/^(\d*)-(\d*)$/, range, capture: :all_but_first) do
        ["", ""] -> :unsatisfiable
        ["", suffix] -> suffix_byte_range(suffix, size)
        [first, ""] -> open_byte_range(first, size)
        [first, last] -> bounded_byte_range(first, last, size)
        _malformed -> :unsatisfiable
      end
    end
  end

  defp parse_byte_range(_unsupported_unit, _size), do: :full

  defp suffix_byte_range(suffix, size) do
    with {length, ""} <- Integer.parse(suffix),
         true <- length > 0 and size > 0 do
      first = max(size - length, 0)
      {:partial, first, size - 1}
    else
      _invalid -> :unsatisfiable
    end
  end

  defp open_byte_range(first, size) do
    with {first, ""} <- Integer.parse(first),
         true <- first < size do
      {:partial, first, size - 1}
    else
      _invalid -> :unsatisfiable
    end
  end

  defp bounded_byte_range(first, last, size) do
    with {first, ""} <- Integer.parse(first),
         {last, ""} <- Integer.parse(last),
         true <- first <= last and first < size do
      {:partial, first, min(last, size - 1)}
    else
      _invalid -> :unsatisfiable
    end
  end

  defp attachment_expired?(%{expires_at: nil}), do: false

  defp attachment_expired?(%{expires_at: expires_at}) do
    DateTime.compare(expires_at, DateTime.utc_now()) != :gt
  end

  # Attachment not yet linked to a message — only allow the original uploader
  defp authorized_for_attachment?(user_id, %{message: nil, uploader_id: uploader_id})
       when is_binary(uploader_id) do
    user_id == uploader_id
  end

  # Unlinked legacy rows have no attributable owner and therefore fail closed.
  defp authorized_for_attachment?(_user_id, %{message: nil}), do: false

  defp authorized_for_attachment?(user_id, %{message: message}) do
    cond do
      message.channel_id ->
        case Servers.get_channel(message.channel_id) do
          nil -> false
          channel -> Servers.user_is_channel_member?(user_id, channel)
        end

      message.conversation_id ->
        Chat.user_is_participant?(user_id, message.conversation_id)

      true ->
        false
    end
  end

  defp attachment_json(attachment) do
    %{
      id: attachment.id,
      filename: attachment.filename,
      content_type: attachment.content_type,
      size_bytes: attachment.size_bytes,
      message_id: attachment.message_id,
      encrypted: attachment.encrypted,
      expires_at: attachment.expires_at
    }
  end
end
