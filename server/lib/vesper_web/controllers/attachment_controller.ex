defmodule VesperWeb.AttachmentController do
  use VesperWeb, :controller
  alias Vesper.Chat
  alias Vesper.Chat.{Attachment, FileStorage}
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

      attrs =
        case params["message_id"] do
          nil -> attrs
          id -> Map.put(attrs, :message_id, id)
        end

      validation = Attachment.changeset(%Attachment{}, attrs)

      if validation.valid? do
        case FileStorage.store(upload.path, upload.filename) do
          {:ok, storage_key} ->
            changeset =
              Attachment.changeset(%Attachment{}, Map.put(attrs, :storage_key, storage_key))

            case Repo.insert(changeset) do
              {:ok, attachment} ->
                conn
                |> put_status(:created)
                |> json(%{attachment: attachment_json(attachment)})

              {:error, _changeset} ->
                FileStorage.delete(storage_key)

                conn
                |> put_status(:unprocessable_entity)
                |> json(%{error: "could not save attachment"})
            end

          {:error, _reason} ->
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

  def show(conn, %{"id" => id}) do
    user = conn.assigns.current_user

    case Repo.get(Attachment, id) do
      nil ->
        conn |> put_status(:not_found) |> json(%{error: "not found"})

      attachment ->
        attachment = Repo.preload(attachment, :message)

        if authorized_for_attachment?(user.id, attachment) do
          path = FileStorage.get_path(attachment.storage_key)

          if File.exists?(path) do
            # For encrypted attachments, don't leak filename or content_type
            # in HTTP headers — the client decrypts metadata from the message.
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
        else
          conn |> put_status(:forbidden) |> json(%{error: "access denied"})
        end
    end
  end

  # Attachment not yet linked to a message — only allow the original uploader
  defp authorized_for_attachment?(user_id, %{message: nil, uploader_id: uploader_id})
       when is_binary(uploader_id) do
    user_id == uploader_id
  end

  # Legacy attachments without uploader_id — allow any authenticated user
  defp authorized_for_attachment?(_user_id, %{message: nil}), do: true

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
