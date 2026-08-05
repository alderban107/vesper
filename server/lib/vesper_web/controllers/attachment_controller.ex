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
      expiry_days = Application.get_env(:vesper, :file_expiry_days, 30)

      expires_at =
        DateTime.utc_now()
        |> DateTime.add(expiry_days * 86_400, :second)
        |> DateTime.truncate(:second)

      attrs = %{
        filename: upload.filename,
        content_type: upload.content_type,
        size_bytes: file_size,
        storage_key: "pending-validation",
        encrypted: params["encrypted"] == "true",
        expires_at: expires_at,
        uploader_id: user.id
      }

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
  end

  def create(conn, _params) do
    conn |> put_status(:bad_request) |> json(%{error: "file is required"})
  end

  defp store_upload_with_quota(upload, attrs) do
    case FileStorage.store(upload.path, upload.filename) do
      {:ok, storage_key} ->
        result =
          try do
            AttachmentBlobLock.with_lock(storage_key, fn ->
              # The first store discovers the backend key. Repeat it under the
              # key lock so a concurrent rejected upload or expiry cleanup
              # cannot delete this blob immediately before our row commits.
              case FileStorage.store(upload.path, upload.filename) do
                {:ok, ^storage_key} -> :ok
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

    if File.exists?(path) do
      # For encrypted attachments, don't leak filename or content_type in HTTP
      # headers — the client decrypts metadata from the message.
      {resp_type, resp_filename} =
        if attachment.encrypted do
          {"application/octet-stream", attachment.id}
        else
          safe_filename = String.replace(attachment.filename, ~r/["\r\n\\]/, "_")
          {attachment.content_type || "application/octet-stream", safe_filename}
        end

      conn
      |> put_resp_content_type(resp_type)
      |> put_resp_header("content-disposition", ~s(attachment; filename="#{resp_filename}"))
      |> send_file(200, path)
    else
      conn |> put_status(:not_found) |> json(%{error: "file not found"})
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
